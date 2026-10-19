import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export class Catalog {
  constructor(path, blobs) {
    this.path = path;
    this.blobs = blobs;
    this.entries = new Map();
    this.queue = Promise.resolve();
  }
  async initialize() {
    try {
      for (const item of JSON.parse(await readFile(this.path, "utf8")))
        this.entries.set(item.digest, item);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  list() {
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  add(item) {
    const job = this.queue.then(async () => {
      if (
        !item ||
        !/^[a-f0-9]{64}$/.test(item.digest) ||
        !["haus", "ha"].includes(item.kind) ||
        !Number.isSafeInteger(item.createdAt) ||
        item.createdAt < 0 ||
        item.createdAt > Date.now() + 60000
      )
        throw new Error("invalid_backup_metadata");
      const info = await this.blobs.info(item.digest);
      if (info.size !== item.bytes) throw new Error("invalid_backup_size");
      this.entries.set(item.digest, {
        digest: item.digest,
        kind: item.kind,
        createdAt: item.createdAt,
        bytes: item.bytes,
      });
      const counts = { haus: 0, ha: 0 };
      const expired = [];
      for (const entry of this.list())
        if (++counts[entry.kind] > (entry.kind === "ha" ? 7 : 24)) {
          this.entries.delete(entry.digest);
          expired.push(entry.digest);
        }
      await this.save();
      for (const digest of expired) await this.blobs.remove(digest);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  remove(digest) {
    const job = this.queue.then(async () => {
      this.entries.delete(digest);
      await this.save();
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async save() {
    const temporary = this.path + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(this.list()), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.path);
  }
}
