import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";

/** Per-digest read/exclusive leases: a delete never invalidates an active reader. */
export class BlobReaders {
  constructor() {
    this.items = new Map();
  }
  acquire(id, exclusive = false) {
    const known = this.items.get(id);
    if (known?.exclusive || (exclusive && known?.readers))
      throw new Error("blob_in_use");
    const item = known || { readers: 0, exclusive: false };
    if (exclusive) item.exclusive = true;
    else item.readers++;
    this.items.set(id, item);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) item.exclusive = false;
      else item.readers--;
      if (!item.exclusive && !item.readers) this.items.delete(id);
    };
  }
}

export function sameFile(before, after) {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Open once: fstat/range reads and verification refer to the same actual file. */
export async function openBlobRead(file, release, maxBytes) {
  let handle;
  try {
    // O_NONBLOCK avoids hanging on a malicious FIFO; O_NOFOLLOW rejects symlinks.
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.size > maxBytes
    )
      throw new Error("invalid_media");
    if (!sameFile(info, await lstat(file))) throw new Error("blob_changed");
    let closed = false;
    return {
      info,
      handle,
      stream: (range = {}) =>
        handle.createReadStream({ ...range, autoClose: false }),
      unchanged: async () => {
        try {
          return (
            sameFile(info, await handle.stat()) &&
            sameFile(info, await lstat(file))
          );
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await handle.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      release();
    }
    if (error.code === "ENOENT") throw new Error("media_not_found");
    if (error.code === "ELOOP") throw new Error("invalid_media");
    throw error;
  }
}
