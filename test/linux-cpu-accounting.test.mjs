import test from "node:test";
import assert from "node:assert/strict";
import { HostTelemetry } from "../lib/host-telemetry.mjs";

const cpus = (user, idle) => [{ model: "CPU", times: { user, idle } }];
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10);

test("Linux disk wait remains in elapsed CPU time without becoming processor work", async () => {
  const snapshots = [
    "cpu 1000 0 100 100 1000 0 0 0 100 0\ncpu0 1000 0 100 100 1000 0 0 0 100 0\n",
    "cpu 1010 0 110 105 1075 0 0 0 110 0\n",
  ];
  const telemetry = new HostTelemetry({
    platform: "linux",
    container: false,
    read: async (path) => {
      assert.equal(path, "/proc/stat");
      return snapshots.shift();
    },
  });
  assert.equal(await telemetry.sampleCpu(cpus(11000, 1000)), null);
  // 20 busy ticks, 5 idle, 75 I/O wait. Guest time duplicates user time.
  close(await telemetry.sampleCpu(cpus(11200, 1050)), 0.2);
});

test("counter resets and decreasing Linux I/O wait do not fabricate CPU spikes", async () => {
  let raw = "cpu 1000 0 100 100 1000 0 0 0\n";
  const telemetry = new HostTelemetry({
    platform: "linux",
    container: false,
    read: async () => raw,
  });
  await telemetry.sampleCpu(cpus(1, 9));
  raw = "cpu 1010 0 100 110 999 0 0 0\n";
  assert.equal(await telemetry.sampleCpu(cpus(2, 18)), null);
  raw = "cpu 1020 0 100 200 999 0 0 0\n";
  close(await telemetry.sampleCpu(cpus(3, 27)), 0.1);
  raw = "cpu 1 0 1 10 0 0 0 0\n";
  assert.equal(await telemetry.sampleCpu(cpus(4, 36)), null);
  assert.equal(await telemetry.sampleCpu(cpus(5, 45)), null);
});

test("missing or malformed proc counters change accounting source with a fresh baseline", async () => {
  let raw = "cpu0 1000 0 100 100 1000 0 0 0\n";
  const telemetry = new HostTelemetry({
    platform: "linux",
    container: false,
    read: async () => raw,
  });
  assert.equal(await telemetry.sampleCpu(cpus(1, 9)), null);
  close(await telemetry.sampleCpu(cpus(3, 17)), 0.2);
  raw = "cpu 1000 0 100 100 1000 0 0 0\n";
  assert.equal(await telemetry.sampleCpu(cpus(4, 26)), null);
  raw = "cpu 1030 0 100 170 1000 0 0 0\n";
  close(await telemetry.sampleCpu(cpus(5, 35)), 0.3);
  raw = "cpu -1 0 0 1\n";
  assert.equal(await telemetry.sampleCpu(cpus(6, 44)), null);
  raw = "cpu 0 invalid 0 1\n";
  close(await telemetry.sampleCpu(cpus(8, 52)), 0.2);
});

test("other platforms and container capacity keep their existing accounting source", async () => {
  for (const [platform, container] of [
    ["win32", false],
    ["darwin", false],
    ["linux", true],
  ]) {
    const telemetry = new HostTelemetry({
      platform,
      container,
      read: async () => assert.fail("unexpected host proc read"),
    });
    assert.equal(await telemetry.sampleCpu(cpus(1, 9)), null);
    close(await telemetry.sampleCpu(cpus(4, 16)), 0.3);
  }
});

test("visible Linux telemetry uses the same complete counters during initial and one-second samples", async (t) => {
  let at = 0;
  let raw = "cpu 1000 0 100 100 1000 0 0 0\n";
  let osTicks = 0;
  const system = {
    cpus: () => cpus(100 + osTicks * 20, 10 + osTicks++ * 5),
    totalmem: () => 1024 ** 3,
    freemem: () => 512 * 1024 ** 2,
    release: () => "6.8.0-generic",
    hostname: () => "fixture",
    arch: () => "x64",
    uptime: () => 100,
    loadavg: () => [1, 1, 1],
  };
  const telemetry = await new HostTelemetry({
    platform: "linux",
    container: false,
    nativeServices: false,
    system,
    now: () => at,
    read: async (path) => {
      if (path === "/proc/stat") return raw;
      if (path === "/proc/meminfo")
        return "MemTotal: 1048576 kB\nMemAvailable: 524288 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
      if (path === "/etc/os-release" || path === "/proc/self/mounts") return "";
      throw Error("optional field unavailable");
    },
    list: async () => [],
    run: async () => {
      throw Error("optional tool unavailable");
    },
  }).initialize({ poll: false });
  t.after(() => telemetry.stop());
  assert.equal(telemetry.status().cpu.usage, null);
  at = 1000;
  raw = "cpu 1010 0 110 105 1075 0 0 0\n";
  await telemetry.sample();
  close(telemetry.status().cpu.usage, 0.2);
  assert.equal(Date.parse(telemetry.status().sampledAt), 1000);
  at = 2000;
  raw = "cpu 1010 0 110 205 1075 0 0 0\n";
  await telemetry.sample();
  close(telemetry.status().cpu.usage, 0);
});
