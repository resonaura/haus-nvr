import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWindowsResources,
  windowsResources,
} from "../lib/windows-resources.mjs";
import { HostTelemetry, sanitizeHostReport } from "../lib/host-telemetry.mjs";

const fixture = (changes = {}) => ({
  CpuPercent: 37.5,
  Processors: [{ Name: "Native CPU", NumberOfLogicalProcessors: 12 }],
  MemoryTotal: 15 * 1024 ** 3,
  MemoryAvailable: 6 * 1024 ** 3,
  PageFileAvailable: true,
  SwapTotal: 8 * 1024 ** 3,
  SwapUsed: 2 * 1024 ** 3,
  UptimeSeconds: 250000,
  ...changes,
});

test("native Windows resources include all CPUs, physical used RAM, pagefile and host uptime", () => {
  const result = parseWindowsResources(
    fixture({
      Processors: [
        { Name: "Socket A", NumberOfLogicalProcessors: 12 },
        { Name: "Socket B", NumberOfLogicalProcessors: 12 },
      ],
    }),
  );
  assert.deepEqual(result.cpu, {
    model: "Socket A · Socket B",
    logicalCores: 24,
    usage: 0.375,
    loadAverage: [],
  });
  assert.equal(result.memory.totalBytes, 15 * 1024 ** 3);
  assert.equal(result.memory.usedBytes, 9 * 1024 ** 3);
  assert.equal(result.swap.usedBytes, 2 * 1024 ** 3);
  assert.equal(result.swap.totalBytes, 8 * 1024 ** 3);
  assert.equal(result.uptimeSeconds, 250000);
});

test("zero pagefile/CPU values remain valid while unavailable counters never become zeros", () => {
  assert.deepEqual(
    parseWindowsResources(fixture({ SwapTotal: 0, SwapUsed: 0 })).swap,
    { supported: true, totalBytes: 0, usedBytes: 0 },
  );
  assert.equal(parseWindowsResources(fixture({ CpuPercent: 0 })).cpu.usage, 0);
  assert.equal(
    parseWindowsResources(fixture({ CpuPercent: null })).cpu.usage,
    null,
  );
  assert.equal(
    parseWindowsResources(fixture({ CpuPercent: 101 })).cpu.usage,
    null,
  );
  assert.equal(
    parseWindowsResources(fixture({ PageFileAvailable: false })).swap.supported,
    false,
  );
  assert.equal(
    parseWindowsResources(fixture({ PageFileAvailable: false })).swap.usedBytes,
    null,
  );
  assert.equal(
    parseWindowsResources(fixture({ UptimeSeconds: null })).uptimeSeconds,
    null,
  );
  for (const MemoryAvailable of [null, -1, 99 * 1024 ** 3, "123"])
    assert.throws(
      () => parseWindowsResources(fixture({ MemoryAvailable })),
      /unavailable/,
    );
  assert.throws(
    () => parseWindowsResources(fixture({ Processors: [] })),
    /unavailable/,
  );
});

test("the Windows path works without WSL and all fixed queries are read-only, bounded and locale independent", async () => {
  for (const wsl of [false, true]) {
    let executed;
    const result = await windowsResources({
      wsl,
      run: async (file, args, options) => {
        executed = {
          file,
          script: Buffer.from(args.at(-1), "base64").toString("utf16le"),
          options,
        };
        return "\uFEFF" + JSON.stringify(fixture());
      },
    });
    assert.equal(
      executed.file,
      wsl
        ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        : "powershell.exe",
    );
    assert.equal(result.cpu.logicalCores, 12);
    assert.equal(executed.options.timeout, 10000);
    assert.equal(executed.options.maxBuffer, 65536);
    assert.match(executed.script, /Win32_PerfFormattedData_PerfOS_Processor/);
    assert.match(executed.script, /Win32_PageFileUsage/);
    assert.doesNotMatch(
      executed.script,
      /Get-Counter|SerialNumber|CommandLine|Set-|Remove-|Invoke-/,
    );
  }
});

function collector(platform, { succeeds = () => true, now = () => 1000 } = {}) {
  return new HostTelemetry({
    platform,
    nativeServices: false,
    container: false,
    now,
    system: {
      cpus: () => [{ model: "WSL CPU", times: { idle: 1, user: 9 } }],
      totalmem: () => 3 * 1024 ** 3,
      freemem: () => 1024 ** 3,
      release: () =>
        platform === "win32" ? "10.0.19045" : "6.18-microsoft-standard-WSL2",
      arch: () => "x64",
      uptime: () => 100,
      hostname: () => "fixture",
      loadavg: () => [1, 2, 3],
    },
    list: async () => [],
    read: async () => {
      throw Error("unavailable");
    },
    run: async (file, args = []) => {
      if (file.endsWith("powershell.exe") && args.includes("-EncodedCommand")) {
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        if (
          script.includes("Win32_PerfFormattedData_PerfOS_Processor") &&
          succeeds()
        )
          return JSON.stringify(fixture());
      }
      throw Error("unavailable");
    },
  });
}

test("collectors prefer the complete Windows host on both native Windows and WSL", async () => {
  for (const platform of ["win32", "linux"]) {
    const telemetry = await collector(platform).initialize({ poll: false });
    const report = sanitizeHostReport(telemetry.status(), 1000);
    assert.equal(report.platform, "win32");
    assert.equal(report.metricsScope, "windows");
    assert.equal(report.cpu.logicalCores, 12);
    assert.equal(report.cpu.model, "Native CPU");
    assert.equal(report.cpu.usage, 0.375);
    assert.deepEqual(report.cpu.loadAverage, []);
    assert.equal(report.memory.usedBytes, 9 * 1024 ** 3);
    assert.equal(report.memory.totalBytes, 15 * 1024 ** 3);
    assert.equal(report.swap.usedBytes, 2 * 1024 ** 3);
    assert.equal(report.uptimeSeconds, 250000);
    assert.equal(report.serviceScope, platform === "linux" ? "wsl" : undefined);
    assert.equal(
      report.runtime?.kind,
      platform === "linux" ? "wsl" : undefined,
    );
    telemetry.stop();
  }
});

test("a failed native refresh keeps the original timestamp; recovery resumes fresh host metrics", async () => {
  let clock = 1000,
    succeeds = true;
  const telemetry = await collector("linux", {
    now: () => clock,
    succeeds: () => succeeds,
  }).initialize({ poll: false });
  const first = telemetry.status();
  clock += 5000;
  succeeds = false;
  await telemetry.sample();
  assert.deepEqual(telemetry.status(), first);
  clock += 30000;
  assert.throws(
    () => sanitizeHostReport(telemetry.status(), clock),
    /invalid_host_report/,
  );
  succeeds = true;
  await telemetry.sample();
  assert.equal(telemetry.status().metricsScope, "windows");
  assert.equal(telemetry.status().sampledAt, new Date(clock).toISOString());
  telemetry.stop();
});

test("WSL-only fallback is explicitly scoped and never pretends its limits are host counters", async () => {
  const telemetry = await collector("linux", {
    succeeds: () => false,
  }).initialize({ poll: false });
  assert.equal(telemetry.status().metricsScope, "wsl");
  assert.equal(telemetry.status().platform, "linux");
  assert.equal(telemetry.status().memory.totalBytes, 3 * 1024 ** 3);
  telemetry.stop();
});
