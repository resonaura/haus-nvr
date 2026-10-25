// Optional privileged read-only hardware probe. Never export raw SMBIOS records.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { linuxInstalledMemory } from "./host-memory.mjs";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1].startsWith("/"))
  throw Error(
    "Usage: node lib/host-memory-probe.mjs --output /absolute/hardware.json",
  );
const installedBytes = await linuxInstalledMemory({ hardwareFile: null });
if (installedBytes === null)
  throw Error("Installed memory is not reported by the host firmware.");
const output = args[1],
  temporary = `${output}.${randomUUID()}.tmp`;
const bootId = (
  await readFile("/proc/sys/kernel/random/boot_id", "utf8")
).trim();
if (!/^[a-f\d-]{36}$/i.test(bootId)) throw Error("Invalid boot identity.");
await mkdir(dirname(output), { recursive: true, mode: 0o755 });
try {
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      installedBytes,
      bootId,
      sampledAt: new Date().toISOString(),
    }) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  await rename(temporary, output);
} finally {
  await unlink(temporary).catch(() => {});
}
