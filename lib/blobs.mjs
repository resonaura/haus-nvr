import {
  mkdir,
  stat,
  statfs,
  readdir,
  open,
  link,
  unlink,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BlobReaders, openBlobRead } from "./blob-readers.mjs";
import { BlobVerification } from "./blob-verification.mjs";
export function blobPath(root, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_digest");
  return join(root, id);
}
export class Blobs {
  constructor(
    root,
    {
      maxBytes = null,
      reserveBytes = 512 * 1024 ** 2,
      maxTransfers = 2,
      maxFileBytes = 16 * 1024 ** 3,
      filesystem = statfs,
      verification = {},
    } = {},
  ) {
    this.root = root;
    this.maxBytes = maxBytes;
    this.reserveBytes = reserveBytes;
    this.maxTransfers = maxTransfers;
    this.maxFileBytes = maxFileBytes;
    this.filesystem = filesystem;
    this.limitSource = maxBytes === null ? "default" : "environment";
    this.used = 0;
    this.reserved = 0;
    this.active = 0;
    this.readers = new BlobReaders();
    this.verification = new BlobVerification(this, verification);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (name.startsWith(".partial-")) await unlink(join(this.root, name));
      else if (/^[a-f0-9]{64}$/.test(name))
        this.used += (await stat(blobPath(this.root, name))).size;
    }
  }
  async status() {
    const fs = await this.filesystem(this.root);
    const freeBytes = fs.bavail * fs.bsize;
    const diskAvailable = Math.max(0, freeBytes - this.reserveBytes);
    const availableBytes = Math.max(
      0,
      Math.min(diskAvailable, (this.maxBytes ?? Infinity) - this.used) -
        this.reserved,
    );
    return {
      usedBytes: this.used,
      // Older helpers require a finite capacity even for an unlimited policy.
      maxBytes: Math.min(this.maxBytes ?? Infinity, this.used + diskAvailable),
      storageLimitBytes: this.maxBytes,
      limitSource: this.limitSource,
      reserveBytes: this.reserveBytes,
      totalBytes: fs.blocks * fs.bsize,
      availableBytes,
      freeBytes,
      reservedBytes: this.reserved,
      activeTransfers: this.active,
      verification: this.verification.status(),
    };
  }
  setLimit(bytes, source = "user") {
    this.maxBytes = bytes;
    this.limitSource = source;
  }
  /** Reserve bounded temporary encoder output against the same storage budget. */
  async reserveTransient(bytes) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > this.maxFileBytes ||
      this.used + this.reserved + bytes > (this.maxBytes ?? Infinity)
    )
      throw new Error("storage_full");
    this.reserved += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
    };
    try {
      const fs = await this.filesystem(this.root);
      if (fs.bavail * fs.bsize - this.reserved < this.reserveBytes)
        throw new Error("storage_full");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  async put(id, source, length) {
    const output = blobPath(this.root, id);
    if (!Number.isSafeInteger(length) || length <= 0)
      throw new Error("invalid_size");
    if (length > this.maxFileBytes) throw new Error("invalid_size");
    if (length > (this.maxBytes ?? Infinity)) throw new Error("storage_full");
    if (this.active >= this.maxTransfers) throw new Error("transfer_busy");
    if (await stat(output).catch(() => null)) return { existing: true };
    // Reserve synchronously before awaiting filesystem capacity: concurrent uploads share the budget.
    if (this.used + this.reserved + length > (this.maxBytes ?? Infinity))
      throw new Error("storage_full");
    this.active++;
    this.reserved += length;
    const temporary = join(this.root, `.partial-${randomUUID()}`);
    try {
      const fs = await this.filesystem(this.root);
      if (fs.bavail * fs.bsize - this.reserved < this.reserveBytes)
        throw new Error("storage_full");
      let size = 0;
      const hash = createHash("sha256");
      const verify = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > length) return callback(new Error("invalid_size"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        source,
        verify,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (size !== length || hash.digest("hex") !== id)
        throw new Error("digest_mismatch");
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Identical digests may race; replacing identical verified bytes is safe, count only once.
      let existed = false;
      // Immutable identical-digest commits may share a lease; DELETE remains
      // exclusive, while concurrent verified uploads can still coalesce.
      const releaseCommit = this.readers.acquire(id);
      try {
        await link(temporary, output);
        this.used += length;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        existed = true;
      } finally {
        releaseCommit();
      }
      return { existing: existed };
    } finally {
      this.active--;
      this.reserved -= length;
      await unlink(temporary).catch(() => {});
    }
  }
  async info(id) {
    return stat(blobPath(this.root, id));
  }
  openRead(id) {
    const file = blobPath(this.root, id);
    return openBlobRead(file, this.readers.acquire(id), this.maxFileBytes);
  }
  verify(id, options) {
    blobPath(this.root, id);
    return this.verification.verify(id, options);
  }
  async remove(id) {
    const file = blobPath(this.root, id);
    const release = this.readers.acquire(id, true);
    try {
      const info = await stat(file).catch(() => null);
      if (info) {
        await unlink(file);
        this.used = Math.max(0, this.used - info.size);
      }
    } finally {
      release();
    }
  }
}
export function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw new Error("invalid_range");
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1]
    ? m[2]
      ? Math.min(size - 1, Number(m[2]))
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    throw new Error("invalid_range");
  return { start, end, partial: true };
}
