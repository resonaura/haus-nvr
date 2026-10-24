import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostHardware,
  parseWindowsHardware,
  parseLinuxGpus,
  sanitizeHardware,
} from "../lib/host-hardware.mjs";

test("native Windows OS and every GPU remain distinct from WSL resources and unsafe 32-bit memory guesses", () => {
  const report = parseWindowsHardware(
    {
      OperatingSystem: {
        Caption: "Microsoft Windows 11 Home",
        Version: "10.0.26100",
        BuildNumber: "26100",
        OSArchitecture: "64-bit",
        SerialNumber: "private",
      },
      GPUs: [
        {
          Name: "Integrated adapter",
          AdapterCompatibility: "Vendor A",
          DriverVersion: "1",
          AdapterRAM: 512000000,
        },
        {
          Name: "Discrete adapter",
          AdapterCompatibility: "Vendor B",
          AdapterRAM: 4293918720,
        },
      ],
    },
    "2026-10-24T20:00:00.000Z",
  );
  assert.equal(report.operatingSystem.name, "Microsoft Windows 11 Home");
  assert.equal(report.operatingSystem.platform, "win32");
  assert.equal(report.gpus.adapters.length, 2);
  assert.ok(
    report.gpus.adapters.every(
      (g) => g.memoryBytes === null && g.kind === null,
    ),
  );
  assert.ok(!JSON.stringify(report).includes("private"));
});
test("unsupported native queries stay unavailable instead of becoming zero adapters", () => {
  assert.equal(
    sanitizeHardware({
      operatingSystem: { name: "Windows", source: "windows-cim" },
    }).operatingSystem,
    undefined,
  );
  assert.equal(parseWindowsHardware({ GPUs: null }).gpus.available, false);
  assert.equal(parseWindowsHardware({ GPUs: [] }).gpus.available, true);
  assert.equal(
    sanitizeHardware({ operatingSystem: { name: "fake", source: "unknown" } })
      .operatingSystem,
    undefined,
  );
});
test("Linux inventories every actual display-class PCI function without guessing topology from names", () => {
  const report = parseLinuxGpus(
    "Slot:\t0000:01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tAMD [1002]\nDevice:\tGraphics [1234]\n\nSlot:\t0000:02:00.0\nClass:\t3D controller [0302]\nVendor:\tNVIDIA [10de]\nDevice:\tGraphics [2345]\n\nSlot:\t0000:03:00.0\nClass:\tAudio device [0403]\nDevice:\tGPU Audio\n",
  );
  assert.equal(report.adapters.length, 2);
  assert.deepEqual(
    report.adapters.map((a) => a.kind),
    [null, null],
  );
});
test("Windows probing uses bounded fixed read-only selectors and does not request private identifiers or unreliable RAM", async () => {
  let command;
  await hostHardware({
    platform: "linux",
    wsl: true,
    run: async (file, args, options) => {
      command = { file, args, options };
      return JSON.stringify({ GPUs: [] });
    },
  });
  assert.match(command.file, /WindowsPowerShell/);
  assert.equal(command.options.maxBuffer, 65536);
  const script = Buffer.from(command.args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Caption,Version,BuildNumber,OSArchitecture/);
  assert.doesNotMatch(script, /SerialNumber|AdapterRAM|Set-|Remove-|Invoke-/);
});

test("hardware inventory is cached between live resource samples and refreshed independently", async () => {
  const { HostTelemetry } = await import("../lib/host-telemetry.mjs");
  let clock = 1000,
    probes = 0;
  const system = {
    cpus: () => [{ model: "CPU", times: { idle: 10, user: 10 } }],
    totalmem: () => 1000,
    freemem: () => 500,
    release: () => "6.8.0",
    arch: () => "x64",
    uptime: () => 1,
    hostname: () => "fixture",
    loadavg: () => [0, 0, 0],
  };
  const telemetry = await new HostTelemetry({
    platform: "linux",
    container: false,
    nativeServices: true,
    system,
    now: () => clock,
    list: async () => [],
    read: async () => {
      throw Error("Unavailable");
    },
    run: async (file) => {
      if (file === "lsblk") return JSON.stringify({ blockdevices: [] });
      if (file === "lspci") {
        probes++;
        return "Slot:\t0000:00:02.0\nClass:\tVGA controller [0300]\nDevice:\tActual Graphics [1234]\n";
      }
      throw Error("Unavailable");
    },
  }).initialize({ poll: false });
  assert.equal(probes, 1);
  clock += 5000;
  await telemetry.sample();
  assert.equal(probes, 1);
  assert.equal(
    telemetry.status().gpus.adapters[0].name,
    "Actual Graphics [1234]",
  );
  clock += 60000;
  await telemetry.sample();
  assert.equal(probes, 2);
  telemetry.stop();
});
