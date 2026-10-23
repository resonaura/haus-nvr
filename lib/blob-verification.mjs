import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

/** Actual on-disk verification; no digest-name cache is trusted for an eviction receipt. */
export class BlobVerification {
  constructor(
    blobs,
    {
      timeoutMs = 60000,
      read = (handle, buffer, position) =>
        handle.read(buffer, 0, buffer.length, position),
    } = {},
  ) {
    Object.assign(this, { blobs, timeoutMs, read });
    this.maxConcurrent = 1;
    this.active = 0;
  }
  status() {
    return {
      supported: true,
      maxConcurrent: this.maxConcurrent,
      maxFileBytes: this.blobs.maxFileBytes,
      timeoutMs: this.timeoutMs,
      active: this.active,
    };
  }
  async verify(id, { signal } = {}) {
    if (this.active >= this.maxConcurrent) throw new Error("verification_busy");
    signal?.throwIfAborted();
    this.active++;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const work = this.hash(id, stop).finally(() => {
      this.active--;
    });
    // A stalled filesystem syscall cannot be canceled by JavaScript. Return at
    // the deadline, but keep its slot/read lease until that actual read unwinds.
    // This bounds memory/work and prevents DELETE from racing a timed-out read.
    let aborted;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          aborted = () => reject(stop.reason);
          if (stop.aborted) aborted();
          else stop.addEventListener("abort", aborted, { once: true });
        }),
      ]);
    } catch (error) {
      if (deadline.aborted && !signal?.aborted)
        throw new Error("verification_timeout");
      throw error;
    } finally {
      if (aborted) stop.removeEventListener("abort", aborted);
    }
  }
  async hash(id, stop) {
    let reader;
    try {
      reader = await this.blobs.openRead(id);
      stop.throwIfAborted();
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(256 * 1024);
      let size = 0;
      while (size < reader.info.size) {
        stop.throwIfAborted();
        const { bytesRead } = await this.read(
          reader.handle,
          buffer.subarray(0, Math.min(buffer.length, reader.info.size - size)),
          size,
          stop,
        );
        stop.throwIfAborted();
        if (!bytesRead) throw new Error("blob_changed");
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
        // Yield each chunk so hashing cannot starve media/control requests on weak nodes.
        await setImmediate(undefined, { signal: stop });
      }
      stop.throwIfAborted();
      if (!(await reader.unchanged())) throw new Error("blob_changed");
      if (hash.digest("hex") !== id) throw new Error("digest_mismatch");
      stop.throwIfAborted();
      return { digest: id, bytes: size, verified: true };
    } finally {
      await reader?.close();
    }
  }
}
