import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
/** Fixed executable/argument lists only; never a shell, inspect, environment or process command lines. */
export async function command(file, args, options = {}) {
  const { input, ...overrides } = options;
  const operation = exec(file, args, {
    timeout: 2500,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    ...overrides,
  });
  operation.child.stdin?.end(input);
  const { stdout } = await operation;
  return stdout;
}
const text = (value, length = 160) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, length)
    : "";
const numeric = (value) =>
  value !== null &&
  value !== undefined &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
export function memorySize(value) {
  const match = /^([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?$/.exec(
    String(value),
  );
  if (!match) return null;
  const power = {
    B: 0,
    kB: 1,
    KB: 1,
    KiB: 1,
    MB: 2,
    MiB: 2,
    GB: 3,
    GiB: 3,
    TB: 4,
    TiB: 4,
  }[match[2] || "B"];
  const bytes =
    Number(match[1]) * (match[2]?.includes("i") ? 1024 : 1000) ** power;
  return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : null;
}
function jsonLines(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 256)
    .map((line) => JSON.parse(line));
}
export async function dockerTelemetry(run = command) {
  try {
    // Explicit templates omit Docker's Commands, Labels, mounts and environment.
    // Inventory runs off the one-second resource path. Loaded daemons may
    // need more than the generic 2.5s command limit even for `ps`/`stats`.
    const output = await run(
      "docker",
      [
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}}}',
      ],
      { timeout: 5000 },
    );
    let stats = [];
    try {
      stats = jsonLines(
        await run(
          "docker",
          [
            "stats",
            "--all",
            "--no-stream",
            "--no-trunc",
            "--format",
            '{"ID":{{json .ID}},"CPUPerc":{{json .CPUPerc}},"MemUsage":{{json .MemUsage}}}',
          ],
          { timeout: 5000 },
        ),
      );
    } catch {
      /* Container list remains useful when stats permissions or runtime differ. */
    }
    const byId = new Map(stats.map((row) => [row.ID, row]));
    let cpuPercentBasis = null;
    try {
      const engine = JSON.parse(
        await run(
          "docker",
          ["info", "--format", '{"OSType":{{json .OSType}}}'],
          { timeout: 5000 },
        ),
      );
      cpuPercentBasis =
        engine.OSType === "linux"
          ? "core"
          : engine.OSType === "windows"
            ? "host"
            : null;
    } catch {
      /* A daemon with unknown CPU units does not authorize guessing. */
    }
    return {
      available: true,
      source: "local",
      cpuPercentBasis,
      containers: jsonLines(output).map((row) => {
        const sample = byId.get(row.ID);
        const memory = sample?.MemUsage?.split("/").map((part) =>
          memorySize(part.trim()),
        );
        return {
          id: text(row.ID, 80),
          name: text(row.Names),
          image: text(row.Image, 240),
          state: text(row.State, 40),
          status: text(row.Status),
          cpuPercent: sample ? numeric(sample.CPUPerc?.replace("%", "")) : null,
          memoryUsedBytes: memory?.[0] ?? null,
          memoryLimitBytes: memory?.[1] ?? null,
        };
      }),
    };
  } catch {
    return { available: false, source: "unavailable", containers: [] };
  }
}
export async function pm2Telemetry({
  run = command,
  read = readFile,
  home = process.env.PM2_HOME || join(homedir(), ".pm2"),
  alive = (pid) => process.kill(pid, 0),
  now = Date.now(),
  cli = process.env.HAUS_PM2_CLI,
  platform = process.platform,
} = {}) {
  try {
    const pid = Number((await read(join(home, "pm2.pid"), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("no_daemon");
    alive(pid); // Do not let a dashboard start a stopped PM2 daemon.
    if (!cli && platform === "win32") {
      const candidates = [
        process.env.APPDATA &&
          join(process.env.APPDATA, "npm", "node_modules", "pm2", "bin", "pm2"),
        join(process.execPath, "..", "node_modules", "pm2", "bin", "pm2"),
      ].filter(Boolean);
      for (const candidate of candidates)
        if (
          await access(candidate).then(
            () => true,
            () => false,
          )
        ) {
          cli = candidate;
          break;
        }
      // execFile does not safely launch .cmd shims; invoke the JavaScript CLI directly.
      if (!cli) throw new Error("no_pm2_cli");
    }
    const rows = JSON.parse(
      await run(
        cli ? process.execPath : "pm2",
        cli ? [cli, "jlist"] : ["jlist"],
        { timeout: 5000 },
      ),
    );
    if (!Array.isArray(rows)) throw new Error("invalid_pm2");
    return {
      available: true,
      source: "local",
      cpuPercentBasis: "core",
      // PM2's response includes environment/arguments. Whitelist numeric status only;
      // the raw response is never logged, written to disk or sent across the network.
      processes: rows.slice(0, 256).map((row) => ({
        id: numeric(row.pm_id),
        name: text(row.name),
        status: text(row.pm2_env?.status, 40),
        pid: numeric(row.pid),
        cpuPercent: numeric(row.monit?.cpu),
        memoryBytes: numeric(row.monit?.memory),
        uptimeSeconds: Number.isFinite(row.pm2_env?.pm_uptime)
          ? Math.max(0, (now - row.pm2_env.pm_uptime) / 1000)
          : null,
        restarts: numeric(row.pm2_env?.restart_time),
      })),
    };
  } catch {
    return { available: false, source: "unavailable", processes: [] };
  }
}
