import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemdServices,
  parseWindowsServices,
  SystemServiceTelemetry,
} from "../lib/system-service-telemetry.mjs";
import { sanitizeHostReport } from "../lib/host-telemetry.mjs";

const unit = (cpu, pid = 12) =>
  `Id=fixture.service\nLoadState=loaded\nDescription=Fixture\nActiveState=active\nSubState=running\nMainPID=${pid}\nCPUUsageNSec=${cpu}\nMemoryCurrent=1048576\nActiveEnterTimestampMonotonic=2000000`;
test("systemd measures service CPU deltas and preserves missing/sentinel counters", () => {
  const first = parseSystemdServices(unit(100000000), {
    now: 1000,
    uptimeSeconds: 10,
  });
  assert.equal(first.report.services[0].cpuPercent, null);
  const second = parseSystemdServices(unit(200000000), {
    previous: first.previous,
    now: 2000,
    uptimeSeconds: 11,
  });
  assert.equal(second.report.services[0].cpuPercent, 10);
  assert.equal(second.report.services[0].uptimeSeconds, 9);
  assert.equal(second.report.memoryBytes, 1048576);
  assert.equal(
    parseSystemdServices(unit(300000000, 13), {
      previous: first.previous,
      now: 2000,
    }).report.services[0].cpuPercent,
    null,
  );
  const missing = parseSystemdServices(
    unit("[not set]").replace(
      "MemoryCurrent=1048576",
      "MemoryCurrent=18446744073709551615",
    ),
  );
  assert.equal(missing.report.services[0].cpuPercent, null);
  assert.equal(missing.report.services[0].memoryBytes, null);
});
test("Windows service processes are attributed once and shared owners remain unknown", () => {
  const value = parseWindowsServices(
    {
      Services: [
        {
          Name: "one",
          DisplayName: "One",
          State: "Running",
          ProcessId: 20,
          PathName: "private command",
        },
        { Name: "two", State: "Running", ProcessId: 20 },
        { Name: "three", State: "Running", ProcessId: 30 },
        { Name: "stopped", State: "Stopped", ProcessId: 0 },
      ],
      Processes: [
        { IDProcess: 20, PercentProcessorTime: 12, WorkingSetPrivate: 1000 },
        { IDProcess: 30, PercentProcessorTime: 5, WorkingSetPrivate: 2000 },
      ],
    },
    1000,
  );
  assert.equal(value.services[0].sharedProcess, true);
  assert.equal(value.services[0].cpuPercent, null);
  assert.equal(value.services[2].cpuPercent, 5);
  assert.equal(value.cpuPercent, 17);
  assert.equal(value.memoryBytes, 3000);
  assert.ok(!JSON.stringify(value).includes("private command"));
});
test("Windows and WSL use native read-only service queries; unsupported managers stay absent", async () => {
  const calls = [];
  const sampler = new SystemServiceTelemetry({
    now: () => 1000,
    run: async (file, args) => {
      calls.push({ file, args });
      return '{"Services":[],"Processes":[]}';
    },
  });
  assert.equal(
    (await sampler.collect({ platform: "win32" })).source,
    "windows",
  );
  assert.equal(
    (await sampler.collect({ platform: "linux", wsl: true })).source,
    "windows",
  );
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[1].file.startsWith("/mnt/c/"));
  const script = Buffer.from(calls[0].args.at(-1), "base64").toString(
    "utf16le",
  );
  assert.ok(script.includes("Win32_Service"));
  assert.ok(!script.includes("PathName"));
  assert.equal((await sampler.collect({ platform: "other" })).available, false);
  const denied = new SystemServiceTelemetry({
    run: async () => {
      throw new Error("denied");
    },
  });
  assert.equal((await denied.collect({ platform: "linux" })).available, false);
});
test("macOS reports only the launchd domain that was actually queried", async () => {
  const sampler = new SystemServiceTelemetry({
    uid: () => 501,
    now: () => 1000,
    run: async (file) =>
      file === "launchctl"
        ? "PID\tStatus\tLabel\n12\t0\tlocal.fixture\n-\t0\tlocal.stopped\n"
        : "12 2.5 1024\n",
  });
  const value = await sampler.collect({ platform: "darwin" });
  assert.equal(value.source, "launchd-user");
  assert.equal(value.services[0].cpuPercent, 2.5);
  assert.equal(value.services[0].memoryBytes, 1048576);
  assert.equal(value.services[1].status, "stopped");
});
test("the external-report boundary preserves only allowlisted system service fields", () => {
  const at = Date.now();
  const value = sanitizeHostReport(
    {
      sampledAt: new Date(at).toISOString(),
      scope: "host",
      cpu: { logicalCores: 2 },
      memory: { totalBytes: 1000, usedBytes: 500, availableBytes: 500 },
      systemServices: {
        available: true,
        source: "windows",
        sampledAt: new Date(at).toISOString(),
        cpuPercent: 2,
        memoryBytes: 40,
        environment: "secret",
        services: [
          {
            id: "fixture",
            name: "Fixture",
            status: "running",
            pid: 1,
            cpuPercent: 2,
            memoryBytes: 40,
            sharedProcess: true,
            command: "secret",
          },
        ],
      },
    },
    at,
  );
  assert.equal(value.systemServices.source, "windows");
  assert.equal(value.systemServices.services[0].sharedProcess, true);
  assert.equal(value.systemServices.cpuPercent, 2);
  assert.ok(!JSON.stringify(value).includes("secret"));
});
