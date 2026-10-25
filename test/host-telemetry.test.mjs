import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostTelemetry,
  parseOsRelease,
  readHostReport,
  sanitizeHostReport,
} from "../lib/host-telemetry.mjs";
import {
  linuxDisks,
  linuxBattery,
  macDisks,
  parseMacBattery,
  parseMeminfo,
  parseWindowsBattery,
  windowsBattery,
  windowsTelemetry,
} from "../lib/host-platform.mjs";
import {
  command,
  dockerTelemetry,
  memorySize,
  pm2Telemetry,
} from "../lib/service-telemetry.mjs";

const sample = () => ({
  sampledAt: new Date().toISOString(),
  scope: "host",
  hostname: "home",
  platform: "linux",
  release: "6",
  arch: "arm64",
  uptimeSeconds: 120,
  cpu: { model: "CPU", logicalCores: 4, usage: 0.25, loadAverage: [1, 2, 3] },
  memory: { totalBytes: 1000, availableBytes: 300, usedBytes: 700 },
  swap: { supported: true, totalBytes: 100, usedBytes: 10 },
  disks: [],
  docker: { available: false },
  pm2: { available: false },
});

function memoryDevice(size) {
  const raw = Buffer.alloc(32);
  raw[0] = 17;
  raw[1] = raw.length;
  raw.writeUInt16LE(size, 12);
  return raw;
}
test("host reports whitelist fields, reject stale/future reports and bound lists", () => {
  const input = sample();
  input.password = "secret";
  input.memory.installedBytes = 1024;
  input.battery = { level: 87.5, charging: true, token: "secret" };
  input.docker = {
    available: true,
    socket: "secret",
    containers: Array.from({ length: 300 }, (_, id) => ({
      id: String(id),
      name: "media",
      image: "image:tag",
      state: "running",
      status: "Up",
      cpuPercent: 20,
      memoryUsedBytes: 1,
      memoryLimitBytes: 2,
      environment: { TOKEN: "secret" },
      command: "secret",
    })),
  };
  input.pm2 = {
    available: true,
    processes: [
      {
        id: 1,
        name: "app",
        pid: 42,
        status: "online",
        cpuPercent: 0,
        memoryBytes: 200,
        uptimeSeconds: 3,
        restarts: 0,
        env: { KEY: "secret" },
        args: "secret",
      },
    ],
  };
  const clean = sanitizeHostReport(input);
  assert.equal(clean.docker.containers.length, 256);
  assert.equal(clean.docker.source, "host-collector");
  assert.deepEqual(clean.battery, { level: 87.5, charging: true });
  assert.equal(clean.memory.installedBytes, 1024);
  assert.ok(!JSON.stringify(clean).includes("secret"));
  assert.throws(() =>
    sanitizeHostReport({
      ...sample(),
      sampledAt: new Date(Date.now() - 31000).toISOString(),
    }),
  );
  assert.throws(() =>
    sanitizeHostReport({
      ...sample(),
      sampledAt: new Date(Date.now() + 6000).toISOString(),
    }),
  );
});
test("Linux host reports identify the installed distribution without evaluating os-release", async (t) => {
  assert.deepEqual(
    parseOsRelease(
      'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\nSHELL=$(touch /tmp/nope)',
    ),
    { distribution: "ubuntu", osName: "Ubuntu 24.04.3 LTS" },
  );
  const clean = sanitizeHostReport({
    ...sample(),
    distribution: "ubuntu",
    osName: "Ubuntu 24.04.3 LTS",
    osReleaseSecret: "must be dropped",
  });
  assert.equal(clean.distribution, "ubuntu");
  assert.equal(clean.osName, "Ubuntu 24.04.3 LTS");
  assert.ok(!JSON.stringify(clean).includes("must be dropped"));
  const system = {
    cpus: () => [{ model: "CPU", times: { user: 1, idle: 9 } }],
    totalmem: () => 1024,
    freemem: () => 512,
    release: () => "6.8.0-generic",
    hostname: () => "miku",
    arch: () => "x64",
    uptime: () => 100,
    loadavg: () => [0, 0, 0],
  };
  const telemetry = await new HostTelemetry({
    platform: "linux",
    system,
    container: false,
    nativeServices: false,
    read: async (file) => {
      if (file === "/etc/os-release")
        return 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n';
      if (file === "/proc/meminfo")
        return "MemTotal: 1 kB\nMemAvailable: 0.5 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
      if (file === "/sys/firmware/dmi/entries/17-0/raw")
        return memoryDevice(8192);
      if (file === "/sys/firmware/dmi/entries/17-1/raw")
        return memoryDevice(8192);
      if (file === "/proc/self/mounts") return "";
      throw new Error("unexpected read");
    },
    list: async (path) =>
      path === "/sys/firmware/dmi/entries" ? ["17-0", "17-1"] : [],
    run: async () => {
      throw new Error("no disk tool available");
    },
  }).initialize({ poll: false });
  t.after(() => telemetry.stop());
  assert.equal(telemetry.status().distribution, "ubuntu");
  assert.equal(telemetry.status().osName, "Ubuntu 24.04.3 LTS");
  assert.equal(telemetry.status().memory.installedBytes, 16 * 1024 ** 3);
  assert.equal(telemetry.status().scope, "host");
});
test("host battery telemetry is read-only and normalized on Linux and macOS", async () => {
  const linux = await linuxBattery({
    list: async () => [{ name: "BAT0" }, { name: "AC" }],
    read: async (file) => {
      if (file.endsWith("/capacity")) return "42\n";
      if (file.endsWith("/status")) return "Charging\n";
      throw new Error("unsupported optional battery field");
    },
  });
  assert.deepEqual(linux, { level: 42, charging: true });
  assert.deepEqual(
    await linuxBattery({
      list: async () => ["BAT0", "AC"],
      read: async (file) => {
        if (file.endsWith("BAT0/capacity")) return "100\n";
        if (file.endsWith("BAT0/status")) return "Full\n";
        if (file.endsWith("AC/type")) return "Mains\n";
        if (file.endsWith("AC/online")) return "1\n";
        throw new Error("unreported");
      },
    }),
    { level: 100, charging: false, powerConnected: true },
  );
  assert.deepEqual(
    parseMacBattery(
      "Now drawing from 'AC Power'\n-InternalBattery-0 (id=1) 84%; charging; 0:22 remaining",
    ),
    {
      level: 84,
      charging: true,
      powerConnected: true,
    },
  );
  assert.deepEqual(
    parseMacBattery("-InternalBattery-0 100%; charged; 0:00 remaining"),
    {
      level: 100,
      charging: false,
    },
  );
});
test("Windows battery charging uses the native charging flag and WSL interop", async () => {
  assert.deepEqual(
    parseWindowsBattery({
      Battery: [{ EstimatedChargeRemaining: 64, BatteryStatus: 2 }],
      BatteryStatus: [
        {
          Active: true,
          Charging: true,
          Discharging: false,
          RemainingCapacity: 6400,
        },
      ],
    }),
    { level: 64, charging: true, powerConnected: true },
  );
  assert.deepEqual(
    parseWindowsBattery({
      Battery: [{ EstimatedChargeRemaining: 55, BatteryStatus: 2 }],
    }),
    { level: 55, charging: null, powerConnected: true },
  );
  assert.deepEqual(
    parseWindowsBattery({
      Battery: [{ EstimatedChargeRemaining: 50, BatteryStatus: 6 }],
      BatteryStatus: [{ Active: true, Charging: false, Discharging: true }],
    }),
    { level: 50, charging: false },
  );

  const full = parseWindowsBattery({
    Battery: [{ EstimatedChargeRemaining: 100, BatteryStatus: 2 }],
    BatteryStatus: [
      { Active: true, Charging: false, Discharging: false, PowerOnline: true },
    ],
  });
  assert.deepEqual(full, { level: 100, charging: false, powerConnected: true });
  assert.deepEqual(
    sanitizeHostReport({ ...sample(), battery: full }).battery,
    full,
  );
  assert.deepEqual(
    parseWindowsBattery({
      Battery: [{ EstimatedChargeRemaining: 77, BatteryStatus: 1 }],
      BatteryStatus: [
        {
          Active: true,
          Charging: false,
          Discharging: true,
          PowerOnline: false,
        },
      ],
    }),
    { level: 77, charging: false, powerConnected: false },
  );

  let batteryQueries = 0;
  const run = async (file, args) => {
    assert.equal(
      file,
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.match(script, /-Namespace root\\wmi -ClassName BatteryStatus/);
    assert.match(script, /Select-Object[^;]*Charging,Discharging/);
    batteryQueries++;
    return JSON.stringify({
      Battery: [{ EstimatedChargeRemaining: 64, BatteryStatus: 2 }],
      BatteryStatus: [{ Active: true, Charging: true, Discharging: false }],
    });
  };
  assert.deepEqual(await windowsBattery({ run, wsl: true }), {
    level: 64,
    charging: true,
    powerConnected: true,
  });
  assert.equal(batteryQueries, 1);
});
test("WSL host telemetry samples Windows battery state and throttles interop", async (t) => {
  let now = 1_000_000;
  let batteryQueries = 0;
  const system = {
    cpus: () => [{ model: "CPU", times: { user: 1, idle: 9 } }],
    totalmem: () => 1024,
    freemem: () => 512,
    release: () => "5.15.167.4-microsoft-standard-WSL2",
    hostname: () => "black-laptop",
    arch: () => "x64",
    uptime: () => 100,
    loadavg: () => [0, 0, 0],
  };
  const telemetry = await new HostTelemetry({
    platform: "linux",
    system,
    container: false,
    nativeServices: false,
    now: () => now,
    read: async (file) => {
      if (file === "/proc/meminfo")
        return "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
      if (file === "/etc/os-release")
        return 'ID=ubuntu\nPRETTY_NAME="Ubuntu"\n';
      if (file === "/proc/self/mounts") return "";
      throw new Error("unavailable");
    },
    list: async () => [],
    run: async (file, args = []) => {
      if (file === "lsblk") throw new Error("unavailable");
      if (file === "/usr/bin/wslpath") throw new Error("unavailable");
      if (file.includes("powershell.exe") && args.includes("-EncodedCommand")) {
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        if (script.includes("-ClassName BatteryStatus")) {
          batteryQueries++;
          return JSON.stringify({
            Battery: [{ EstimatedChargeRemaining: 64, BatteryStatus: 2 }],
            BatteryStatus: [
              { Active: true, Charging: true, Discharging: false },
            ],
          });
        }
      }
      throw new Error("unsupported command");
    },
  }).initialize({ poll: false });
  t.after(() => telemetry.stop());
  assert.deepEqual(telemetry.status().battery, {
    level: 64,
    charging: true,
    powerConnected: true,
  });
  assert.equal(telemetry.status().metricsScope, "wsl");
  assert.equal(batteryQueries, 1);
  now += 5000;
  await telemetry.sample();
  assert.equal(batteryQueries, 1);
  now += 5000;
  await telemetry.sample();
  await telemetry.inventoryRefresh;
  assert.equal(batteryQueries, 2);
});
test("missing Linux battery capacity falls back to energy while absent readings stay unknown", async () => {
  const collect = (values) =>
    linuxBattery({
      list: async () => ["BAT0"],
      read: async (file) => {
        const field = file.split("/").at(-1);
        if (!Object.hasOwn(values, field))
          throw new Error("unsupported reading");
        return values[field];
      },
    });
  for (const capacity of [undefined, "", " \n", "not-a-number"])
    assert.deepEqual(
      await collect({
        ...(capacity === undefined ? {} : { capacity }),
        energy_now: "40000\n",
        energy_full: "80000\n",
        status: "Discharging\n",
      }),
      { level: 50, charging: false },
    );
  assert.deepEqual(
    await collect({ energy_full: "80000", status: "Charging" }),
    { level: null, charging: true },
  );
  assert.deepEqual(await collect({}), { level: null, charging: null });
  assert.deepEqual(
    await collect({ capacity: "0", energy_now: "40000", energy_full: "80000" }),
    { level: 0, charging: null },
  );
});

test("Windows disk use stays unknown when capacity or free space is missing", async () => {
  const rows = [
    { DeviceID: "C:", Size: 1000, FreeSpace: null },
    { DeviceID: "D:", Size: 1000 },
    { DeviceID: "E:", Size: 1000, FreeSpace: "  " },
    { DeviceID: "F:", Size: 1000, FreeSpace: 0 },
    { DeviceID: "G:", Size: null, FreeSpace: 200 },
    { DeviceID: "H:", Size: 1000, FreeSpace: 400 },
  ];
  const { disks } = await windowsTelemetry(async () =>
    JSON.stringify({ Disks: rows }),
  );
  assert.deepEqual(
    disks.map((disk) => disk.usedBytes),
    [null, null, null, 1000, null, 600],
  );
  assert.deepEqual(
    disks.map((disk) => disk.availableBytes),
    [null, null, null, 0, 200, 400],
  );
  assert.equal(disks[4].totalBytes, null);
  const sanitized = sanitizeHostReport({ ...sample(), disks });
  assert.equal(sanitized.disks.length, rows.length);
  assert.equal(sanitized.disks[4].id, "volume:G:");
  assert.equal(sanitized.disks[4].totalBytes, null);
  assert.equal(sanitized.disks[4].availableBytes, 200);
  assert.equal(sanitized.disks[4].usedBytes, null);
});
test("stale external telemetry falls back to container quotas and only the mounted data volume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "haus-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory, "host.json");
  await writeFile(report, JSON.stringify(sample()));
  const capacity = {
    status: () => ({
      cpus: 0.5,
      cpu: 0.6,
      memoryBytes: 1000,
      memoryCurrentBytes: 400,
    }),
  };
  let commands = 0;
  const telemetry = await new HostTelemetry({
    dataPath: directory,
    collectorFile: report,
    container: true,
    capacity,
    nativeServices: true,
    run: async () => {
      commands++;
      throw new Error("forbidden");
    },
    read: async () => "0",
  }).initialize();
  t.after(() => telemetry.stop());
  assert.equal(telemetry.status().scope, "host");
  await writeFile(
    report,
    JSON.stringify({
      ...sample(),
      sampledAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  await telemetry.sample();
  assert.equal(telemetry.status().scope, "container");
  assert.equal(telemetry.status().cpu.logicalCores, 0.5);
  assert.equal(telemetry.status().cpu.usage, 0.6);
  assert.equal(telemetry.status().memory.totalBytes, 1000);
  assert.equal(telemetry.status().memory.usedBytes, 400);
  assert.equal(telemetry.status().disks.length, 1);
  assert.equal(telemetry.status().docker.available, false);
  assert.equal(commands, 0);
  await writeFile(report, "x".repeat(512 * 1024 + 1));
  await assert.rejects(readHostReport(report), /invalid_host_report/);
});
test("Linux memory distinguishes available cache and swap; block disks retain volume parents", async () => {
  const info = parseMeminfo(
    "MemTotal:       1000 kB\nMemAvailable:    400 kB\nSwapTotal:       200 kB\nSwapFree:        150 kB\n",
  );
  assert.equal(info.memory.usedBytes, 600 * 1024);
  assert.equal(info.swap.usedBytes, 50 * 1024);
  const disks = await linuxDisks({
    run: async () =>
      JSON.stringify({
        blockdevices: [
          {
            name: "nvme0n1",
            type: "disk",
            size: 1000,
            model: "Home SSD",
            children: [
              {
                name: "nvme0n1p1",
                type: "part",
                size: 900,
                fstype: "ext4",
                mountpoints: ["/data"],
                label: "Video",
              },
            ],
          },
        ],
      }),
    filesystem: async () => ({
      blocks: 900,
      bsize: 1,
      bfree: 400,
      bavail: 350,
    }),
  });
  assert.equal(disks[0].kind, "disk");
  assert.equal(disks[1].parentId, disks[0].id);
  assert.equal(disks[2].mountpoint, "/data");
  assert.equal(disks[2].usedBytes, 500);
  assert.equal(disks[2].availableBytes, 350);
});
test("macOS disk hierarchy converts a read-only plist over stdin; Windows CIM reports memory/swap/disks", async () => {
  const calls = [];
  const disks = await macDisks({
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return file.endsWith("diskutil")
        ? "<plist>private disk metadata</plist>"
        : JSON.stringify({
            AllDisksAndPartitions: [
              {
                DeviceIdentifier: "disk0",
                Size: 1000,
                Partitions: [
                  {
                    DeviceIdentifier: "disk0s1",
                    Size: 900,
                    MountPoint: "/Volumes/Video",
                    VolumeName: "Video",
                    Content: "apfs",
                  },
                ],
              },
            ],
          });
    },
    filesystem: async () => ({
      blocks: 900,
      bsize: 1,
      bfree: 400,
      bavail: 350,
    }),
  });
  assert.ok(calls[1].options.input.startsWith("<plist>"));
  assert.equal(disks[1].parentId, "disk:disk0");
  assert.equal(disks[1].kind, "volume");
  assert.equal(disks[1].mountpoint, "/Volumes/Video");
  const windows = await windowsTelemetry(async (file, args) => {
    assert.equal(file, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    return JSON.stringify({
      MemoryTotal: 1000,
      MemoryInstalled: 1024,
      MemoryFree: 400,
      SwapTotal: 500,
      SwapFree: 300,
      Battery: [{ EstimatedChargeRemaining: 55, BatteryStatus: 6 }],
      Disks: [
        {
          DeviceID: "C:",
          VolumeName: "System",
          FileSystem: "NTFS",
          Size: 10000,
          FreeSpace: 4000,
        },
      ],
    });
  });
  assert.equal(windows.memory.usedBytes, 600);
  assert.equal(windows.memory.installedBytes, 1024);
  assert.equal(windows.swap.usedBytes, 200);
  assert.deepEqual(windows.battery, { level: 55, charging: true });
  assert.equal(windows.disks[0].mountpoint, "C:\\");
});
test("Docker inventory tolerates slow daemon replies within a bounded background budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-slow-docker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "daemon.mjs");
  await writeFile(
    fixture,
    `
    const operation = process.argv[2];
    if (['ps', 'stats', 'info'].includes(operation))
      await new Promise(resolve => setTimeout(resolve, 2800));
    console.log(JSON.stringify(operation === 'ps'
      ? {ID:'fixture',Names:'home-service',Image:'fixture',State:'running',Status:'Up'}
      : operation === 'stats'
        ? {ID:'fixture',CPUPerc:'25%',MemUsage:'64MiB / 1GiB'}
        : {OSType:'linux'}));
  `,
  );
  const docker = await dockerTelemetry((_file, args, options) =>
    command(process.execPath, [fixture, ...args], options),
  );
  assert.equal(docker.available, true);
  assert.equal(docker.cpuPercentBasis, "core");
  assert.equal(docker.containers[0].cpuPercent, 25);
  assert.equal(docker.containers[0].memoryUsedBytes, 64 * 1024 ** 2);
});

test("Docker/PM2 collectors expose status only and never start a stopped PM2 daemon", async () => {
  const docker = await dockerTelemetry(async (file, args) => {
    assert.equal(file, "docker");
    assert.ok(!args.includes("inspect"));
    return args[0] === "ps"
      ? JSON.stringify({
          ID: "abc",
          Names: "haus",
          Image: "haus:latest",
          State: "running",
          Status: "Up",
        })
      : JSON.stringify({
          ID: "abc",
          CPUPerc: "12.5%",
          MemUsage: "125MiB / 1GiB",
        });
  });
  assert.equal(docker.containers[0].cpuPercent, 12.5);
  assert.equal(docker.containers[0].memoryUsedBytes, 125 * 1024 ** 2);
  assert.equal(memorySize("1.5 GB"), 1500000000);
  const pm2 = await pm2Telemetry({
    read: async () => "42",
    alive: () => {},
    now: 10000,
    run: async () =>
      JSON.stringify([
        {
          pm_id: 1,
          name: "helper",
          pid: 43,
          monit: { cpu: 4, memory: 1024 },
          pm2_env: {
            status: "online",
            pm_uptime: 5000,
            restart_time: 2,
            SECRET: "private",
            args: "private",
          },
        },
      ]),
  });
  assert.equal(pm2.processes[0].uptimeSeconds, 5);
  assert.equal(pm2.processes[0].restarts, 2);
  assert.ok(!JSON.stringify(pm2).includes("private"));
  let invoked = false;
  const stopped = await pm2Telemetry({
    read: async () => {
      throw new Error("ENOENT");
    },
    run: async () => {
      invoked = true;
      return "[]";
    },
  });
  assert.equal(stopped.available, false);
  assert.equal(invoked, false);
});
