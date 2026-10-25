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

test("a warm Windows reader streams one-second samples without relaunching or retiming stale values", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { WindowsResourceSampler } =
    await import("../lib/windows-resources.mjs");
  let clock = 1000,
    launches = 0,
    closed = false,
    killed = false;
  let child;
  const sampler = new WindowsResourceSampler({
    now: () => clock,
    launch: (file, args) => {
      launches++;
      assert.equal(file, "powershell.exe");
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /ReadLine/);
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = {
        write: (value) => assert.equal(value, "sample\n"),
        end: () => {
          closed = true;
        },
      };
      child.kill = () => {
        killed = true;
        child.emit("exit", 0);
      };
      return child;
    },
  });
  const first = sampler.read();
  const frame = JSON.stringify(fixture());
  child.stdout.write(frame.slice(0, 25));
  child.stdout.write(frame.slice(25) + "\n");
  assert.equal((await first).sampledAt, 1000);
  clock += 1000;
  child.stdout.write(JSON.stringify(fixture({ CpuPercent: 50 })) + "\n");
  assert.equal((await sampler.read()).cpu.usage, 0.5);
  assert.equal(launches, 1);
  clock += 3000;
  child.stdout.write('{"error":"native_resources_unavailable"}\n');
  await assert.rejects(sampler.read(), /unavailable/);
  child.stdout.write(frame + "\n");
  assert.equal((await sampler.read()).sampledAt, clock);
  sampler.stop();
  assert.equal(closed, true);
  assert.equal(killed, true);
  await assert.rejects(sampler.read(), /unavailable/);
});

test("Linux fast samples do not rerun disk/service inventory every second", async () => {
  let clock = 1000,
    user = 10,
    idle = 10,
    commands = 0;
  const telemetry = await new HostTelemetry({
    platform: "linux",
    nativeServices: true,
    container: false,
    now: () => clock,
    system: {
      cpus: () => [{ model: "CPU", times: { user, idle } }],
      totalmem: () => 1000,
      freemem: () => 500,
      release: () => "6.8",
      arch: () => "x64",
      uptime: () => clock / 1000,
      hostname: () => "fixture",
      loadavg: () => [1, 2, 3],
    },
    list: async () => [],
    read: async (file) => {
      if (file === "/proc/meminfo")
        return "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 50 kB\n";
      throw Error("unavailable");
    },
    run: async (file) => {
      commands++;
      if (file === "lsblk") return '{"blockdevices":[]}';
      throw Error("unavailable");
    },
  }).initialize({ poll: false });
  const baseline = commands;
  for (let second = 1; second < 10; second++) {
    clock += 1000;
    user += 25;
    idle += 75;
    await telemetry.sample();
    assert.equal(telemetry.status().cpu.usage, 0.25);
    assert.equal(telemetry.status().memory.usedBytes, 750 * 1024);
    assert.equal(telemetry.status().sampledAt, new Date(clock).toISOString());
    assert.equal(commands, baseline);
  }
  clock += 1000;
  await telemetry.sample();
  await telemetry.inventoryRefresh;
  assert.ok(commands > baseline);
  telemetry.stop();
});

test("a slow inventory refresh never blocks one-second counters or overwrites a newer sample", async () => {
  let clock = 1000,
    user = 10,
    idle = 10,
    inventories = 0;
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const telemetry = await new HostTelemetry({
    platform: "linux",
    nativeServices: false,
    container: false,
    now: () => clock,
    system: {
      cpus: () => [{ model: "CPU", times: { user, idle } }],
      totalmem: () => 1000,
      freemem: () => 500,
      release: () => "6.8",
      arch: () => "x64",
      uptime: () => clock / 1000,
      hostname: () => "fixture",
      loadavg: () => [1, 2, 3],
    },
    list: async () => [],
    read: async (path) => {
      if (path === "/proc/meminfo")
        return "MemTotal: 1000 kB\nMemAvailable: 250 kB\n";
      throw Error("unavailable");
    },
    run: async (file) => {
      if (file !== "lsblk") throw Error("unavailable");
      if (++inventories > 1) await gate;
      return '{"blockdevices":[]}';
    },
  }).initialize({ poll: false });
  clock += 10000;
  user += 30;
  idle += 70;
  await telemetry.sample();
  assert.ok(telemetry.inventoryRefresh);
  clock += 1000;
  user += 40;
  idle += 60;
  await telemetry.sample();
  const latest = telemetry.status();
  assert.equal(latest.cpu.usage, 0.4);
  assert.equal(latest.sampledAt, new Date(clock).toISOString());
  finish();
  await telemetry.inventoryRefresh;
  assert.equal(telemetry.status().sampledAt, latest.sampledAt);
  assert.equal(telemetry.status().cpu.usage, 0.4);
  telemetry.stop();
});
