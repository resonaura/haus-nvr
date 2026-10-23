import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { HostTelemetry, sanitizeHostReport } from "./host-telemetry.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (
  outputIndex < 0 ||
  !args[outputIndex + 1] ||
  args.some(
    (arg, index) =>
      index !== outputIndex + 1 && !["--output", "--once"].includes(arg),
  )
) {
  console.error(
    "Usage: node lib/host-collector.mjs --output /path/to/telemetry/host.json [--once]",
  );
  process.exit(1);
}
const output = resolve(args[outputIndex + 1]);
await mkdir(dirname(output), { recursive: true, mode: 0o750 });
const telemetry = new HostTelemetry({ nativeServices: true });
await telemetry.initialize({ poll: false });
let stopping = false;
async function save() {
  const temporary = `${output}.${randomUUID()}.tmp`;
  let file;
  try {
    const report = sanitizeHostReport(telemetry.status());
    file = await open(temporary, "wx", 0o640);
    await file.writeFile(JSON.stringify(report) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, output);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}
await save();
if (args.includes("--once")) telemetry.stop();
else {
  // Recursive scheduling prevents overlapping collectors on weak machines.
  let timer;
  const tick = async () => {
    if (stopping) return;
    try {
      await telemetry.sample();
      await save();
    } catch {
      console.error(
        "Haus host telemetry sample unavailable; the worker will mark stale data unavailable.",
      );
    }
    if (!stopping) timer = setTimeout(tick, 5000);
  };
  timer = setTimeout(tick, 5000);
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    telemetry.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
