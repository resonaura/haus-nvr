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
      workspaceRoot = root,
      inspect = stat,
      workspaceBackingCapacity = async () => null,
      verification = {},
      backingCapacity = async () => null,
      now = Date.now,
    } = {},
  ) {
    this.root = root;
    this.maxBytes = maxBytes;
    this.reserveBytes = reserveBytes;
    this.maxTransfers = maxTransfers;
    this.maxFileBytes = maxFileBytes;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.inspect = inspect;
    this.workspaceBackingCapacity = workspaceBackingCapacity;
    this.workspaceReserved = 0;
    this.workspaceSeparate = false;
    this.workspaceSameFilesystem = workspaceRoot === root;
    this.backingCapacity = backingCapacity;
    this.now = now;
    this.growth = new Map();
    this.limitSource = maxBytes === null ? "default" : "environment";
    this.used = 0;
    this.reserved = 0;
    this.active = 0;
    this.readers = new BlobReaders();
    this.verification = new BlobVerification(this, verification);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (this.workspaceRoot !== this.root) {
      const [archive, workspace] = await Promise.all([
        this.inspect(this.root),
        this.inspect(this.workspaceRoot),
      ]);
      const known = archive.dev > 0 && workspace.dev > 0;
      this.workspaceSeparate = known && archive.dev !== workspace.dev;
      this.workspaceSameFilesystem = known && archive.dev === workspace.dev;
    }
    for (const name of await readdir(this.root)) {
      if (name.startsWith(".partial-")) await unlink(join(this.root, name));
      else if (/^[a-f0-9]{64}$/.test(name))
        this.used += (await stat(blobPath(this.root, name))).size;
    }
  }
  async status() {
    const capacity = await this.diskCapacity();
    const { fs, freeBytes, backing } = capacity;
    const workspace = await this.workspaceCapacity(capacity);
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
      ...(backing ? { backing } : {}),
      ...(workspace ? { workspace } : {}),
    };
  }
  async diskCapacity() {
    const fs = await this.filesystem(this.root);
    const backing = await this.backingCapacity();
    let freeBytes = fs.bavail * fs.bsize;
    if (backing) {
      const sampled = Date.parse(backing.sampledAt);
      let growth = 0;
      for (const [at, bytes] of this.growth) {
        if (this.now() - at > 31000) this.growth.delete(at);
        else if (at > sampled) growth += bytes;
      }
      freeBytes =
        backing.state === "fresh" && Number.isFinite(sampled)
          ? Math.min(freeBytes, Math.max(0, backing.availableBytes - growth))
          : 0;
    }
    return { fs, freeBytes, backing };
  }
  async workspaceCapacity(archive) {
    if (this.workspaceRoot === this.root) return null;
    let freeBytes = null,
      backing;
    try {
      if (this.workspaceSameFilesystem) {
        const capacity = archive ?? (await this.diskCapacity());
        freeBytes = capacity.freeBytes;
        backing = capacity.backing;
        if (backing && backing.state !== "fresh") freeBytes = null;
      } else {
        const fs = await this.filesystem(this.workspaceRoot);
        const available = fs.bavail * fs.bsize;
        if (Number.isSafeInteger(available)) freeBytes = Math.max(0, available);
        backing = await this.workspaceBackingCapacity();
        if (backing) {
          freeBytes =
            backing.state === "fresh" &&
            Number.isSafeInteger(backing.availableBytes)
              ? Math.min(freeBytes ?? 0, Math.max(0, backing.availableBytes))
              : null;
        }
      }
    } catch {
      freeBytes = null;
    }
    const reservedBytes = this.workspaceSeparate
      ? this.workspaceReserved
      : this.reserved;
    return {
      state: freeBytes === null ? "unavailable" : "fresh",
      separateFilesystem: this.workspaceSeparate,
      freeBytes,
      reserveBytes: this.reserveBytes,
      reservedBytes,
      availableBytes: Math.max(
        0,
        (freeBytes ?? 0) - this.reserveBytes - reservedBytes,
      ),
      ...(backing ? { backing } : {}),
    };
  }
  noteGrowth(bytes) {
    // Round upward so a commit in the same millisecond/bucket as a capacity
    // sample is conservatively debited until the next actual native reading.
    const bucket = (Math.floor(this.now() / 1000) + 1) * 1000;
    this.growth.set(bucket, (this.growth.get(bucket) ?? 0) + bytes);
    for (const at of this.growth.keys())
      if (this.now() - at > 31000) this.growth.delete(at);
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
    this.workspaceReserved += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
      this.workspaceReserved -= bytes;
    };
    try {
      const capacity = await this.diskCapacity();
      const { freeBytes } = capacity;
      const workspace = await this.workspaceCapacity(capacity);
      if (freeBytes - this.reserved < this.reserveBytes)
        throw new Error("storage_full");
      // Read the counters after the awaited filesystem calls. A failed peer
      // reservation may already have released its allowance in this turn.
      const workingReserved = this.workspaceSeparate
        ? this.workspaceReserved
        : this.reserved;
      if (
        workspace &&
        (workspace.freeBytes === null ||
          workspace.freeBytes - workingReserved < this.reserveBytes)
      )
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
      const { freeBytes } = await this.diskCapacity();
      if (freeBytes - this.reserved < this.reserveBytes)
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
        this.noteGrowth(length);
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
