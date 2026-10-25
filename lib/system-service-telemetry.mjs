import { uptime } from "node:os";
import { command } from "./service-telemetry.mjs";

const text = (value, max = 240) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, max)
    : "";
const number = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) < Number.MAX_SAFE_INTEGER
    ? Number(value)
    : null;
const unavailable = () => ({
  available: false,
  source: "unavailable",
  services: [],
});
const sum = (rows, key) =>
  rows.every((row) => number(row[key]) !== null)
    ? rows.reduce((total, row) => total + Number(row[key]), 0)
    : null;

export function parseSystemdServices(
  output,
  { previous = new Map(), now = Date.now(), uptimeSeconds = uptime() } = {},
) {
  const next = new Map();
  const services = String(output)
    .split(/\r?\n\r?\n/)
    .slice(0, 512)
    .flatMap((block) => {
      const fields = Object.fromEntries(
        block.split(/\r?\n/).flatMap((line) => {
          const at = line.indexOf("=");
          return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
        }),
      );
      if (!fields.Id?.endsWith(".service") || fields.LoadState === "not-found")
        return [];
      const cpu = number(fields.CPUUsageNSec);
      const pid = number(fields.MainPID);
      const prior = previous.get(fields.Id);
      const elapsed = prior ? now - prior.at : 0;
      const cpuPercent =
        cpu !== null &&
        prior?.cpu !== null &&
        prior?.cpu !== undefined &&
        prior.pid === pid &&
        cpu >= prior.cpu &&
        elapsed > 0 &&
        elapsed <= 60000
          ? (cpu - prior.cpu) / (elapsed * 10000)
          : null;
      next.set(fields.Id, { cpu, pid, at: now });
      const entered = number(fields.ActiveEnterTimestampMonotonic);
      return [
        {
          id: text(fields.Id),
          name: text(fields.Description) || text(fields.Id),
          status: text(fields.ActiveState, 40) || "unknown",
          detail: text(fields.SubState, 40),
          pid: pid > 0 ? pid : null,
          cpuPercent,
          memoryBytes: number(fields.MemoryCurrent),
          uptimeSeconds:
            fields.ActiveState === "active" &&
            entered > 0 &&
            entered / 1000000 <= uptimeSeconds
              ? uptimeSeconds - entered / 1000000
              : null,
        },
      ];
    });
  const active = services.filter((row) =>
    ["active", "activating", "reloading"].includes(row.status),
  );
  return {
    report: {
      available: true,
      source: "systemd",
      sampledAt: new Date(now).toISOString(),
      services,
      cpuPercent: sum(active, "cpuPercent"),
      memoryBytes: sum(active, "memoryBytes"),
    },
    previous: next,
  };
}

// Fixed read-only CIM properties. Never collect service command lines, account names or environment.
const windowsScript =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$services=@(Get-CimInstance Win32_Service -Property Name,DisplayName,State,ProcessId -OperationTimeoutSec 2 | Select-Object Name,DisplayName,State,ProcessId);$processes=@();try{$processes=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime,WorkingSetPrivate -OperationTimeoutSec 2 | Select-Object IDProcess,PercentProcessorTime,WorkingSetPrivate)}catch{};[pscustomobject]@{Services=$services;Processes=$processes}|ConvertTo-Json -Depth 4 -Compress";

export function parseWindowsServices(value, now = Date.now()) {
  if (!Array.isArray(value?.Services))
    throw new Error("invalid_windows_services");
  const processes = new Map(
    (Array.isArray(value.Processes) ? value.Processes : [])
      .slice(0, 1024)
      .map((row) => [number(row.IDProcess), row]),
  );
  const inputs = value.Services.slice(0, 512);
  const counts = new Map();
  for (const row of inputs) {
    const pid = number(row.ProcessId);
    if (pid > 0 && row.State === "Running")
      counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  const services = inputs
    .filter((row) => text(row.Name))
    .map((row) => {
      const pid = number(row.ProcessId);
      const sharedProcess = (counts.get(pid) || 0) > 1;
      const sample =
        pid > 0 && row.State === "Running" && !sharedProcess
          ? processes.get(pid)
          : null;
      return {
        id: text(row.Name),
        name: text(row.DisplayName) || text(row.Name),
        status: text(row.State, 40).toLowerCase(),
        detail: "",
        pid: pid > 0 ? pid : null,
        sharedProcess,
        cpuPercent: number(sample?.PercentProcessorTime),
        memoryBytes: number(sample?.WorkingSetPrivate),
        uptimeSeconds: null,
      };
    });
  // Several Windows services share a host process. Count that process once and
  // leave per-service ownership unknown instead of repeating its resource use.
  const measured = [...counts.keys()].map((pid) => ({
    cpuPercent: number(processes.get(pid)?.PercentProcessorTime),
    memoryBytes: number(processes.get(pid)?.WorkingSetPrivate),
  }));
  return {
    available: true,
    source: "windows",
    sampledAt: new Date(now).toISOString(),
    services,
    cpuPercent: sum(measured, "cpuPercent"),
    memoryBytes: sum(measured, "memoryBytes"),
  };
}

export class SystemServiceTelemetry {
  constructor({
    run = command,
    now = Date.now,
    uptimeSeconds = uptime,
    uid = () => process.getuid?.(),
  } = {}) {
    Object.assign(this, { run, now, uptimeSeconds, uid });
    this.previous = new Map();
  }
  async collect({ platform = process.platform, wsl = false } = {}) {
    try {
      if (platform === "win32" || wsl) {
        const raw = await this.run(
          wsl
            ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
            : "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(windowsScript, "utf16le").toString("base64"),
          ],
          { timeout: 8000, maxBuffer: 1024 * 1024 },
        );
        return parseWindowsServices(
          JSON.parse(raw.replace(/^\uFEFF/, "")),
          this.now(),
        );
      }
      if (platform === "linux") {
        const output = await this.run(
          "systemctl",
          [
            "show",
            "*.service",
            "--all",
            "--no-pager",
            "--property=Id,LoadState,Description,ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestampMonotonic",
          ],
          { timeout: 2500 },
        );
        const result = parseSystemdServices(output, {
          previous: this.previous,
          now: this.now(),
          uptimeSeconds: this.uptimeSeconds(),
        });
        this.previous = result.previous;
        return result.report;
      }
      if (platform === "darwin") {
        const [units, stats] = await Promise.all([
          this.run("launchctl", ["list"]),
          this.run("ps", ["-axo", "pid=,pcpu=,rss="]),
        ]);
        const samples = new Map(
          stats
            .trim()
            .split("\n")
            .slice(0, 4096)
            .map((line) => {
              const [pid, cpu, memory] = line.trim().split(/\s+/);
              return [
                number(pid),
                {
                  cpuPercent: number(cpu),
                  memoryBytes:
                    number(memory) === null ? null : Number(memory) * 1024,
                },
              ];
            }),
        );
        const services = units
          .trim()
          .split("\n")
          .slice(1, 513)
          .flatMap((line) => {
            const [rawPid, status, id] = line.trim().split(/\s+/);
            if (!id) return [];
            const pid = number(rawPid),
              sample = pid > 0 ? samples.get(pid) : null;
            return [
              {
                id: text(id),
                name: text(id),
                status:
                  pid > 0 ? "running" : status === "0" ? "stopped" : "failed",
                detail: "",
                pid,
                cpuPercent: sample?.cpuPercent ?? null,
                memoryBytes: sample?.memoryBytes ?? null,
                uptimeSeconds: null,
              },
            ];
          });
        const active = services.filter((row) => row.status === "running");
        return {
          available: true,
          source: this.uid() === 0 ? "launchd" : "launchd-user",
          sampledAt: new Date(this.now()).toISOString(),
          services,
          cpuPercent: sum(active, "cpuPercent"),
          memoryBytes: sum(active, "memoryBytes"),
        };
      }
    } catch {
      /* Unsupported managers and denied counters remain unavailable. */
    }
    return unavailable();
  }
}
