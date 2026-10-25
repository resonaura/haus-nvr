import * as os from "node:os";
import { sanitizeStorageMedia } from "./storage-media.mjs";
import { hostHardware, sanitizeHardware } from "./host-hardware.mjs";
import { windowsDisks } from "./windows-disks.mjs";
import { linuxInstalledMemory } from "./host-memory.mjs";
import { sanitizeStorageBacking, wslStorageBacking } from "./wsl-storage.mjs";
import { access, open, readdir, readFile } from "node:fs/promises";
import {
  linuxDisks,
  linuxBattery,
  macDisks,
  parseMeminfo,
  parseMacBattery,
  volumeAt,
  windowsBattery,
  windowsTelemetry,
} from "./host-platform.mjs";
import {
  command,
  dockerTelemetry,
  pm2Telemetry,
} from "./service-telemetry.mjs";

const MAX_REPORT = 512 * 1024;
const clean = (value, length = 240) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, length)
    : "";
const count = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const unavailable = (name) => ({
  available: false,
  source: "unavailable",
  [name]: [],
});
export function sanitizeHostReport(input, now = Date.now()) {
  const sampled = Date.parse(input?.sampledAt);
  if (
    !Number.isFinite(sampled) ||
    now - sampled > 30000 ||
    sampled - now > 5000 ||
    !["host", "container"].includes(input.scope)
  )
    throw new Error("invalid_host_report");
  const cpu = input.cpu || {},
    memory = input.memory || {},
    swap = input.swap || {};
  if (
    !count(memory.totalBytes) ||
    count(memory.usedBytes) === null ||
    count(memory.availableBytes) === null ||
    !count(cpu.logicalCores)
  )
    throw new Error("invalid_host_report");
  const service = (value, field, map) =>
    value?.available === true
      ? {
          available: true,
          source: "host-collector",
          [field]: (Array.isArray(value[field]) ? value[field] : [])
            .slice(0, 256)
            .map(map),
        }
      : unavailable(field);
  let storageBacking;
  try {
    storageBacking = sanitizeStorageBacking(input.storageBacking, now);
  } catch {}
  return {
    sampledAt: new Date(sampled).toISOString(),
    scope: input.scope,
    hostname: clean(input.hostname, 160),
    platform: clean(input.platform, 40),
    distribution: clean(input.distribution, 80) || null,
    osName: clean(input.osName, 160) || null,
    release: clean(input.release, 120),
    arch: clean(input.arch, 40),
    ...sanitizeHardware(input),
    ...(input.metricsScope === "wsl" ? { metricsScope: "wsl" } : {}),
    uptimeSeconds: count(input.uptimeSeconds),
    ...(storageBacking ? { storageBacking } : {}),
    battery:
      input.battery && typeof input.battery === "object"
        ? {
            level:
              count(input.battery.level) !== null && input.battery.level <= 100
                ? input.battery.level
                : null,
            ...(typeof input.battery.powerConnected === "boolean"
              ? { powerConnected: input.battery.powerConnected }
              : {}),
            charging:
              typeof input.battery.charging === "boolean"
                ? input.battery.charging
                : null,
          }
        : null,
    cpu: {
      model: clean(cpu.model),
      logicalCores: count(cpu.logicalCores),
      usage: count(cpu.usage) === null ? null : Math.min(1, cpu.usage),
      loadAverage: (Array.isArray(cpu.loadAverage) ? cpu.loadAverage : [])
        .slice(0, 3)
        .map(count),
    },
    memory: {
      totalBytes: memory.totalBytes,
      installedBytes: count(memory.installedBytes),
      availableBytes: Math.min(memory.totalBytes, memory.availableBytes),
      usedBytes: Math.min(memory.totalBytes, memory.usedBytes),
    },
    swap: {
      supported: swap.supported === true,
      totalBytes: count(swap.totalBytes),
      usedBytes: count(swap.usedBytes),
    },
    disks: (Array.isArray(input.disks) ? input.disks : [])
      .slice(0, 128)
      .filter(
        (disk) =>
          disk &&
          (disk.totalBytes === null ||
            disk.totalBytes === undefined ||
            count(disk.totalBytes) !== null),
      )
      .map((disk) => ({
        id: clean(disk.id),
        name: clean(disk.name),
        kind: disk.kind === "disk" ? "disk" : "volume",
        type: ["disk", "partition", "container", "volume"].includes(disk.type)
          ? disk.type
          : disk.kind === "disk"
            ? "disk"
            : "volume",
        physical: typeof disk.physical === "boolean" ? disk.physical : null,
        parentId:
          typeof disk.parentId === "string" ? clean(disk.parentId) : null,
        parentIds: (Array.isArray(disk.parentIds)
          ? disk.parentIds
          : typeof disk.parentId === "string"
            ? [disk.parentId]
            : []
        )
          .filter((id) => typeof id === "string" && id !== disk.id)
          .slice(0, 16)
          .map((id) => clean(id)),
        mountpoint:
          typeof disk.mountpoint === "string" ? clean(disk.mountpoint) : null,
        filesystem:
          typeof disk.filesystem === "string"
            ? clean(disk.filesystem, 80)
            : null,
        totalBytes: count(disk.totalBytes),
        usedBytes: count(disk.usedBytes),
        availableBytes: count(disk.availableBytes),
        scope: input.scope,
        ...sanitizeStorageMedia(disk),
        ...([
          "efi",
          "reserved",
          "recovery",
          "data",
          "boot",
          "system",
          "kernel",
          "boot-state",
          "overlay",
          "swap",
          "home",
          "lvm",
          "raid",
          "encrypted",
        ].includes(disk.partitionRole)
          ? { partitionRole: disk.partitionRole }
          : {}),
        ...(Number.isSafeInteger(disk.partitionNumber) &&
        disk.partitionNumber > 0
          ? { partitionNumber: disk.partitionNumber }
          : {}),
        ...(typeof disk.readOnly === "boolean"
          ? { readOnly: disk.readOnly }
          : {}),
        ...(typeof disk.device === "string" &&
        /^\/dev\/[a-zA-Z0-9_!+./-]{1,120}$/.test(disk.device)
          ? { device: clean(disk.device) }
          : {}),
        ...(Array.isArray(disk.mountpoints)
          ? {
              mountpoints: disk.mountpoints
                .filter(
                  (value) => typeof value === "string" && value.startsWith("/"),
                )
                .slice(0, 16)
                .map((value) => clean(value)),
            }
          : {}),
      })),
    docker: service(input.docker, "containers", (row) => ({
      id: clean(row.id, 80),
      name: clean(row.name, 160),
      image: clean(row.image),
      state: clean(row.state, 40),
      status: clean(row.status, 160),
      cpuPercent: count(row.cpuPercent),
      memoryUsedBytes: count(row.memoryUsedBytes),
      memoryLimitBytes: count(row.memoryLimitBytes),
    })),
    pm2: service(input.pm2, "processes", (row) => ({
      id: count(row.id),
      name: clean(row.name, 160),
      status: clean(row.status, 40),
      pid: count(row.pid),
      cpuPercent: count(row.cpuPercent),
      memoryBytes: count(row.memoryBytes),
      uptimeSeconds: count(row.uptimeSeconds),
      restarts: count(row.restarts),
    })),
  };
}

/** Parse the small, public identity fields from os-release without evaluating shell syntax. */
export function parseOsRelease(contents) {
  const values = Object.fromEntries(
    String(contents ?? "")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^(ID|PRETTY_NAME)=([^\n]*)$/.exec(line.trim());
        if (!match) return [];
        let value = match[2].trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        )
          value = value.slice(1, -1);
        return [[match[1], value]];
      }),
  );
  const distribution = values.ID?.toLowerCase();
  const osName = values.PRETTY_NAME;
  return {
    ...(distribution && /^[a-z0-9._-]{1,80}$/.test(distribution)
      ? { distribution }
      : {}),
    ...(osName ? { osName: clean(osName, 160) } : {}),
  };
}

export async function readHostReport(file, now = Date.now()) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPORT)
      throw new Error("invalid_host_report");
    const buffer = Buffer.alloc(MAX_REPORT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REPORT) throw new Error("invalid_host_report");
    return sanitizeHostReport(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      now,
    );
  } finally {
    await handle.close();
  }
}
export async function isContainer() {
  return (
    process.env.HAUS_CONTAINER === "true" ||
    (await access("/.dockerenv").then(
      () => true,
      () => false,
    )) ||
    (await access("/run/.containerenv").then(
      () => true,
      () => false,
    ))
  );
}
/** Bounded cached samples keep slow host tools completely outside the media request path. */
export class HostTelemetry {
  constructor({
    dataPath = "/data",
    capacity,
    collectorFile,
    nativeServices = false,
    container,
    platform = os.platform(),
    system = os,
    read = readFile,
    list = readdir,
    run = command,
    intervalMs = 5000,
    now = Date.now,
  } = {}) {
    Object.assign(this, {
      dataPath,
      capacity,
      collectorFile,
      nativeServices,
      container,
      platform,
      system,
      read,
      list,
      run,
      intervalMs,
      now,
    });
    this.value = null;
    this.stopped = false;
  }
  async initialize({ poll = true } = {}) {
    this.container ??= await isContainer();
    await this.sample();
    if (poll) {
      this.timer = setInterval(
        () => void this.sample().catch(() => {}),
        this.intervalMs,
      );
      this.timer.unref();
    }
    return this;
  }
  async sample() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async collect() {
    if (this.stopped) return;
    if (this.collectorFile) {
      try {
        this.value = await readHostReport(this.collectorFile, this.now());
        return;
      } catch {
        /* Stale/unavailable collectors fall back to truthful local scope. */
      }
    }
    const cpus = this.system.cpus();
    const total = cpus.reduce(
      (sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      0,
    );
    const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    let usage =
      this.previous && total > this.previous.total
        ? Math.max(
            0,
            Math.min(
              1,
              1 - (idle - this.previous.idle) / (total - this.previous.total),
            ),
          )
        : null;
    this.previous = { total, idle };
    const resources = this.capacity?.status();
    const scope = this.container ? "container" : "host";
    let memory = {
      totalBytes: this.system.totalmem(),
      installedBytes: this.container ? null : this.system.totalmem(),
      availableBytes: this.system.freemem(),
      usedBytes: this.system.totalmem() - this.system.freemem(),
    };
    let swap = { supported: false, totalBytes: null, usedBytes: null },
      disks = [],
      battery = null,
      storageBacking;
    if (this.container) {
      if (resources) {
        memory = {
          totalBytes: resources.memoryBytes,
          usedBytes: resources.memoryCurrentBytes,
          availableBytes: Math.max(
            0,
            resources.memoryBytes - resources.memoryCurrentBytes,
          ),
        };
        usage = resources.cpu;
      }
      const [swapMax, swapUsed] = await Promise.all([
        this.read("/sys/fs/cgroup/memory.swap.max", "utf8").catch(() => ""),
        this.read("/sys/fs/cgroup/memory.swap.current", "utf8").catch(() => ""),
      ]);
      if (/^(?:\d+|max)\s*$/.test(swapMax) && /^\d+\s*$/.test(swapUsed))
        swap = {
          supported: true,
          totalBytes: swapMax.trim() === "max" ? null : Number(swapMax),
          usedBytes: Number(swapUsed),
        };
      try {
        disks = [await volumeAt(this.dataPath, { scope, name: "Haus data" })];
      } catch {
        /* Storage status separately reports failures. */
      }
    } else if (this.platform === "linux") {
      const info = parseMeminfo(
        await this.read("/proc/meminfo", "utf8").catch(() => ""),
      );
      const installedBytes = await linuxInstalledMemory({
        list: this.list,
        read: this.read,
      });
      memory = info.memory
        ? { ...info.memory, installedBytes }
        : { ...memory, installedBytes };
      swap = info.swap;
      disks = await linuxDisks({
        run: this.run,
        read: this.read,
        virtualized: /microsoft|wsl/i.test(this.system.release()),
      });
      battery = await linuxBattery({ list: this.list, read: this.read });
      if (/microsoft|wsl/i.test(this.system.release())) {
        const sampleAt = this.now();
        if (
          this.wslBatteryAttemptAt === undefined ||
          sampleAt - this.wslBatteryAttemptAt >= 10000
        ) {
          this.wslBatteryAttemptAt = sampleAt;
          try {
            const windows = await windowsBattery({ run: this.run, wsl: true });
            if (windows) {
              this.wslBattery = windows;
              this.wslBatteryAt = sampleAt;
            }
          } catch {
            // WSL interop may briefly fail; keep a recent native sample.
          }
        }
        if (this.wslBattery && sampleAt - this.wslBatteryAt <= 30000)
          battery = this.wslBattery;
        try {
          const native = await windowsDisks({ run: this.run, wsl: true });
          const root = disks.find((disk) => disk.mountpoint === "/");
          disks = [
            ...native,
            ...(root
              ? [
                  {
                    ...root,
                    id: "wsl:root",
                    name: "Linux filesystem (WSL)",
                    kind: "volume",
                    type: "container",
                    physical: false,
                    parentId: null,
                    parentIds: [],
                  },
                ]
              : []),
          ];
          this.windowsDiskView = true;
        } catch {
          // A short CIM/interop interruption must not replace the native disk
          // tree with synthetic WSL devices. Retain the last whole sample;
          // its original sampledAt still expires through the existing policy.
          if (this.windowsDiskView && this.value) return;
        }
        try {
          storageBacking = await wslStorageBacking({
            run: this.run,
            now: this.now,
          });
        } catch {
          // Retain the mapping with its original timestamp so the worker can
          // stop new growth when it expires. Never label old free space fresh.
          storageBacking = this.value?.storageBacking;
        }
      }
    } else if (this.platform === "darwin") {
      const values = await Promise.allSettled([
        macDisks({ run: this.run }),
        this.run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
        this.run("/usr/bin/vm_stat", []),
        this.run("/usr/bin/pmset", ["-g", "batt"]),
      ]);
      if (values[0].status === "fulfilled") disks = values[0].value;
      if (values[1].status === "fulfilled") {
        const match = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(
          values[1].value,
        );
        if (match)
          swap = {
            supported: true,
            totalBytes: Math.round(Number(match[1]) * 1024 ** 2),
            usedBytes: Math.round(Number(match[2]) * 1024 ** 2),
          };
      }
      if (values[2].status === "fulfilled") {
        const output = values[2].value;
        const page = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
        const fields = Object.fromEntries(
          [...output.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map((match) => [
            match[1],
            Number(match[2]),
          ]),
        );
        if (page) {
          const available = Math.min(
            memory.totalBytes,
            page *
              ((fields["Pages free"] || 0) +
                (fields["Pages inactive"] || 0) +
                (fields["Pages speculative"] || 0)),
          );
          memory = {
            totalBytes: memory.totalBytes,
            installedBytes: memory.installedBytes,
            availableBytes: available,
            usedBytes: memory.totalBytes - available,
          };
        }
      }
      if (values[3].status === "fulfilled")
        battery = parseMacBattery(values[3].value);
    } else if (this.platform === "win32") {
      try {
        const result = await windowsTelemetry(this.run);
        memory = result.memory || memory;
        swap = result.swap;
        disks = result.disks;
        battery = result.battery;
        try {
          disks = await windowsDisks({ run: this.run });
        } catch {
          // Logical volumes still report truthful usage without a disk tree.
        }
      } catch {
        /* Unsupported CIM stays unavailable. */
      }
    }
    let docker = unavailable("containers"),
      pm2 = unavailable("processes");
    if (this.nativeServices && !this.container)
      [docker, pm2] = await Promise.all([
        dockerTelemetry(this.run),
        pm2Telemetry({ run: this.run, read: this.read, now: this.now() }),
      ]);
    if (
      this.nativeServices &&
      !this.container &&
      (this.hardwareAt === undefined || this.now() - this.hardwareAt >= 60000)
    ) {
      this.hardwareAt = this.now();
      this.hardware = await hostHardware({
        platform: this.platform,
        wsl:
          this.platform === "linux" &&
          /microsoft|wsl/i.test(this.system.release()),
        run: this.run,
        now: this.now,
      }).catch(() => sanitizeHardware({}));
    }
    const { installedMemoryBytes, ...hardware } = this.hardware ?? {};
    const value = {
      sampledAt: new Date(this.now()).toISOString(),
      scope,
      hostname: this.system.hostname(),
      platform: this.platform,
      ...(!this.container && this.platform === "linux"
        ? parseOsRelease(
            await this.read("/etc/os-release", "utf8").catch(() => ""),
          )
        : {}),
      release: this.system.release(),
      arch: this.system.arch(),
      ...hardware,
      ...(this.hardware?.operatingSystem?.platform === "win32"
        ? {
            osName: [
              this.hardware.operatingSystem.name,
              this.hardware.operatingSystem.version,
            ]
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
      ...(!this.container &&
      this.platform === "linux" &&
      /microsoft|wsl/i.test(this.system.release())
        ? { metricsScope: "wsl" }
        : {}),
      uptimeSeconds: this.system.uptime(),
      ...(storageBacking ? { storageBacking } : {}),
      battery,
      cpu: {
        model: cpus[0]?.model || "CPU",
        logicalCores:
          this.container && resources ? resources.cpus : cpus.length || 1,
        usage,
        loadAverage: this.container ? [] : this.system.loadavg(),
      },
      memory: {
        ...memory,
        ...(installedMemoryBytes
          ? { installedBytes: installedMemoryBytes }
          : {}),
      },
      swap,
      disks,
      docker,
      pm2,
    };
    this.value = value;
  }
  status() {
    return this.value;
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
