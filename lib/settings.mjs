import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function storageLimitFromEnvironment(value) {
  if (value === undefined || value.trim() === "") return null;
  if (Number(value) === 0) return null;
  const bytes = Number(value) * 1024 ** 3;
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Invalid storage budget");
  return bytes;
}

function validate(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "storageLimitBytes") ||
    (input.storageLimitBytes !== null &&
      (!Number.isSafeInteger(input.storageLimitBytes) ||
        input.storageLimitBytes <= 0))
  )
    throw new Error("invalid_settings");
  return { storageLimitBytes: input.storageLimitBytes };
}

/** A user policy supersedes an explicit environment cap, including null/unlimited. */
export class NodeSettings {
  constructor(file, { environmentLimit = null, apply = () => {} } = {}) {
    this.file = file;
    this.value = { storageLimitBytes: environmentLimit };
    this.source = environmentLimit === null ? "default" : "environment";
    this.apply = apply;
    this.pending = Promise.resolve();
  }
  async initialize() {
    try {
      this.value = validate(JSON.parse(await readFile(this.file, "utf8")));
      this.source = "user";
    } catch (error) {
      // An unreadable policy must never silently drop an explicitly configured cap.
      if (error.code !== "ENOENT") throw error;
    }
    this.apply(this.value.storageLimitBytes, this.source);
    return this;
  }
  status() {
    return { ...this.value, source: this.source };
  }
  async update(input) {
    const value = validate(input);
    const operation = this.pending.then(async () => {
      const temporary = join(dirname(this.file), `.settings-${randomUUID()}`);
      let file;
      try {
        file = await open(temporary, "wx", 0o600);
        await file.writeFile(JSON.stringify(value) + "\n");
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, this.file);
        // Directory fsync is supported on Linux/macOS, but not all Windows volumes.
        const directory = await open(dirname(this.file), "r").catch(() => null);
        if (directory) {
          try {
            await directory.sync().catch(() => {});
          } finally {
            await directory.close();
          }
        }
        this.value = value;
        this.source = "user";
        this.apply(value.storageLimitBytes, "user");
        return this.status();
      } finally {
        await file?.close();
        await unlink(temporary).catch(() => {});
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
