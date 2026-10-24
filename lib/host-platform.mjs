import { readFile, readdir, statfs } from "node:fs/promises";
import { command } from "./service-telemetry.mjs";

export function parseMeminfo(value) {
  const fields = Object.fromEntries(
    [...value.matchAll(/^(\w+):\s+(\d+) kB$/gm)].map((match) => [
      match[1],
      Number(match[2]) * 1024,
    ]),
  );
  const total = fields.MemTotal;
  const available =
    fields.MemAvailable ??
    (fields.MemFree ?? 0) + (fields.Buffers ?? 0) + (fields.Cached ?? 0);
  return {
    memory: Number.isFinite(total)
      ? {
          totalBytes: total,
          availableBytes: Math.min(total, available),
          usedBytes: Math.max(0, total - available),
        }
      : null,
    swap: {
      supported: Number.isFinite(fields.SwapTotal),
      totalBytes: fields.SwapTotal ?? null,
      usedBytes: Number.isFinite(fields.SwapTotal)
        ? Math.max(0, fields.SwapTotal - (fields.SwapFree ?? 0))
        : null,
    },
  };
}
export async function linuxBattery({ list = readdir, read = readFile } = {}) {
  let entries;
  try {
    entries = await list("/sys/class/power_supply");
  } catch {
    return null;
  }
  const names = entries
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter(
      (name) =>
        typeof name === "string" && /^(?:BAT\d*|battery\d*)$/i.test(name),
    );
  if (!names.length) return null;
  const batteries = await Promise.all(
    names.map(async (name) => {
      const directory = `/sys/class/power_supply/${name}`;
      const [capacity, status, energyNow, energyFull] = await Promise.all([
        read(`${directory}/capacity`, "utf8").catch(() => ""),
        read(`${directory}/status`, "utf8").catch(() => ""),
        read(`${directory}/energy_now`, "utf8").catch(() => ""),
        read(`${directory}/energy_full`, "utf8").catch(() => ""),
      ]);
      const capacityValue = positive(String(capacity).trim() || null);
      const nowValue = positive(String(energyNow).trim() || null);
      const fullValue = positive(String(energyFull).trim() || null);
      const level =
        capacityValue !== null && capacityValue <= 100
          ? capacityValue
          : nowValue !== null && fullValue !== null && fullValue > 0
            ? Math.max(0, Math.min(100, (nowValue / fullValue) * 100))
            : null;
      const normalizedStatus = String(status).trim().toLowerCase();
      return {
        level,
        charging:
          normalizedStatus === "charging"
            ? true
            : ["full", "discharging", "not charging"].includes(normalizedStatus)
              ? false
              : null,
      };
    }),
  );
  const levels = batteries
    .map((battery) => battery.level)
    .filter(Number.isFinite);
  const chargingStates = batteries
    .map((battery) => battery.charging)
    .filter((value) => value !== null);
  return {
    level: levels.length
      ? levels.reduce((sum, level) => sum + level, 0) / levels.length
      : null,
    charging: chargingStates.includes(true)
      ? true
      : chargingStates.length
        ? false
        : null,
  };
}

export function parseMacBattery(output) {
  const readings = [...String(output).matchAll(/(\d{1,3})%;\s*([^;\n]+)/g)]
    .map((match) => ({
      level: Math.min(100, Number(match[1])),
      status: match[2].trim().toLowerCase(),
    }))
    .filter((item) => Number.isFinite(item.level));
  if (!readings.length) return null;
  return {
    level:
      readings.reduce((sum, item) => sum + item.level, 0) / readings.length,
    charging: readings.some(
      (item) =>
        item.status === "charging" || item.status === "finishing charge",
    )
      ? true
      : false,
  };
}
const clean = (value, length = 240) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, length)
    : null;
const positive = (value) =>
  value !== null &&
  !(typeof value === "string" && !value.trim()) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const unescapeMount = (value) =>
  value.replace(/\\(040|011|012|134)/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
export async function volumeAt(
  path,
  {
    filesystem = statfs,
    scope = "host",
    name,
    id,
    filesystemType = null,
    parentId = null,
    parentIds = parentId ? [parentId] : [],
  } = {},
) {
  const stats = await filesystem(path);
  const totalBytes = stats.blocks * stats.bsize;
  return {
    id: id || `volume:${path}`,
    name: clean(name || path),
    kind: "volume",
    type: "volume",
    physical: false,
    parentId,
    parentIds,
    mountpoint: clean(path),
    filesystem: clean(filesystemType),
    totalBytes,
    usedBytes: Math.max(0, totalBytes - stats.bfree * stats.bsize),
    availableBytes: Math.max(0, stats.bavail * stats.bsize),
    scope,
  };
}
export async function linuxDisks({
  run = command,
  filesystem = statfs,
  read = readFile,
  virtualized = false,
} = {}) {
  try {
    const value = JSON.parse(
      await run("lsblk", [
        "--json",
        "--bytes",
        "--output",
        "NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,LABEL,MODEL,TRAN,SUBSYSTEMS,PARTTYPE,PARTLABEL,RO",
      ]),
    );
    const disks = [];
    const seen = new Map();
    const walk = async (row, parentId = null) => {
      if (!row || disks.length >= 128 || ["loop", "rom"].includes(row.type))
        return;
      const id = `block:${clean(row.name, 80)}`;
      // Device-mapper/RAID nodes can appear under several physical parents.
      if (seen.has(id)) {
        const existing = seen.get(id);
        if (
          parentId &&
          parentId !== id &&
          !existing.parentIds.includes(parentId)
        )
          existing.parentIds.push(parentId);
        return;
      }
      const mounts = Array.isArray(row.mountpoints)
        ? row.mountpoints.filter(
            (item) => typeof item === "string" && item.startsWith("/"),
          )
        : [];
      const type =
        row.type === "disk"
          ? "disk"
          : row.type === "part"
            ? "partition"
            : "container";
      const virtual =
        virtualized ||
        /(?:virtio|virtual|qemu|vmware|xen|vmbus)/i.test(
          `${row.model || ""} ${row.subsystems || ""} ${row.tran || ""}`,
        );
      const physical =
        type !== "disk" || virtual
          ? false
          : /^(?:ata|sata|sas|scsi|usb|nvme|mmc|ieee1394|fc|fcoe)$/i.test(
                row.tran || "",
              )
            ? true
            : null;
      const purpose = linuxDiskPurpose(row, mounts);
      let partitionNumber;
      if (
        type === "partition" &&
        /^[a-zA-Z0-9_!+-]{1,80}$/.test(row.name ?? "")
      ) {
        const number = Number(
          (
            await read(`/sys/class/block/${row.name}/partition`, "utf8").catch(
              () => "",
            )
          ).trim(),
        );
        if (Number.isSafeInteger(number) && number > 0)
          partitionNumber = number;
      }
      // Retain the coarse protocol-1 kind for older clients. Only whole disks
      // belong to it; partitions and mapped storage must not inflate disk counts.
      const disk = {
        id,
        name: clean(
          row.label || row.partlabel || row.model?.trim() || row.name,
        ),
        kind: type === "disk" ? "disk" : "volume",
        type,
        physical,
        parentId,
        parentIds: parentId ? [parentId] : [],
        mountpoint: null,
        filesystem: clean(row.fstype),
        totalBytes: positive(row.size),
        usedBytes: null,
        availableBytes: null,
        scope: "host",
        ...(/^[a-zA-Z0-9_!+-]{1,80}$/.test(row.name ?? "")
          ? { device: `/dev/${row.name}` }
          : {}),
        ...(purpose ? { partitionRole: purpose } : {}),
        ...(partitionNumber ? { partitionNumber } : {}),
        ...(typeof row.ro === "boolean" ? { readOnly: row.ro } : {}),
      };
      seen.set(id, disk);
      disks.push(disk);
      const orderedMounts = [...mounts].sort(
        (a, b) => a.length - b.length || a.localeCompare(b),
      );
      for (const mount of orderedMounts.slice(0, 16)) {
        if (disks.length >= 128) break;
        if (seen.has(`volume:${mount}`)) continue;
        try {
          const volume = await volumeAt(mount, {
            filesystem,
            parentId: id,
            name: row.label || mount,
            filesystemType: row.fstype,
          });
          if (purpose) volume.partitionRole = purpose;
          volume.mountpoints = mounts.slice(0, 16).map((value) => clean(value));
          volume.device = disk.device;
          if (typeof row.ro === "boolean") volume.readOnly = row.ro;
          seen.set(volume.id, volume);
          disks.push(volume);
          // Bind aliases of the same reported block filesystem share bytes.
          // Retain every mount in details, but measure and count it once.
          break;
        } catch {
          /* Unmounted between discovery and stat. */
        }
      }
      for (const child of (row.children || []).slice(0, 128))
        await walk(child, id);
    };
    for (const row of (value.blockdevices || []).slice(0, 128)) await walk(row);
    if (disks.length) return disks.slice(0, 128);
  } catch {
    /* Minimal hosts may not install util-linux. */
  }
  const output = await read("/proc/self/mounts", "utf8").catch(() => "");
  const mounts = output
    .split("\n")
    .map((line) => line.split(" "))
    .filter(
      ([device, mount, type]) =>
        mount?.startsWith("/") &&
        (device?.startsWith("/dev/") ||
          ["zfs", "btrfs", "nfs", "nfs4", "cifs"].includes(type)),
    )
    .slice(0, 128);
  return (
    await Promise.all(
      mounts.map(async ([device, mount, type]) =>
        volumeAt(unescapeMount(mount), {
          filesystem,
          name: unescapeMount(device),
          filesystemType: type,
        }).catch(() => null),
      ),
    )
  ).filter(Boolean);
}
export function linuxDiskPurpose(row, mounts = []) {
  if (
    String(row.parttype ?? "").toLowerCase() ===
      "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" ||
    mounts.includes("/boot/efi")
  )
    return "efi";
  if (
    String(row.parttype ?? "").toLowerCase() ===
    "de94bba4-06d1-4d40-a16a-bfd50179d6ac"
  )
    return "recovery";
  if (
    String(row.parttype ?? "").toLowerCase() ===
    "e3c9e316-0b5c-4db8-817d-f92df00215ae"
  )
    return "reserved";
  if (row.fstype === "swap") return "swap";
  if (row.fstype === "crypto_LUKS" || row.type === "crypt") return "encrypted";
  if (row.type === "lvm") return "lvm";
  if (/^raid|^md$/.test(row.type ?? "")) return "raid";
  if (mounts.includes("/")) return "system";
  if (mounts.includes("/boot")) return "boot";
  if (mounts.includes("/home")) return "home";
  if (
    mounts.length ||
    [
      "0fc63daf-8483-4772-8e79-3d69d8477de4",
      "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7",
    ].includes(String(row.parttype ?? "").toLowerCase())
  )
    return "data";
}
async function plist(file, args, run) {
  const xml = await run(file, args);
  return JSON.parse(
    await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: xml,
    }),
  );
}
export async function macDisks({ run = command, filesystem = statfs } = {}) {
  // plutil needs piped stdin; command supports it without a shell or a temporary file.
  const result = await plist("/usr/sbin/diskutil", ["list", "-plist"], run);
  const disks = [];
  const walk = async (row, parentId = null) => {
    if (!row || disks.length >= 128) return;
    const id = `disk:${row.DeviceIdentifier}`;
    const physicalStore = row.APFSPhysicalStores?.[0]?.DeviceIdentifier;
    parentId ||= physicalStore ? `disk:${physicalStore}` : null;
    const volume = Boolean(row.VolumeName || row.MountPoint);
    const type =
      row.Content === "Apple_APFS_Container"
        ? "container"
        : volume
          ? "volume"
          : parentId
            ? "partition"
            : "disk";
    const parentIds = (row.APFSPhysicalStores || [])
      .map((store) =>
        typeof store.DeviceIdentifier === "string"
          ? `disk:${store.DeviceIdentifier}`
          : null,
      )
      .filter(Boolean);
    if (parentId && !parentIds.includes(parentId)) parentIds.unshift(parentId);
    const disk = {
      id,
      name: clean(row.VolumeName || row.DeviceIdentifier),
      kind: type === "disk" ? "disk" : "volume",
      type,
      // list-plist cannot distinguish every external physical disk from an
      // attached disk image. Preserve unknown instead of inventing a claim.
      physical:
        type === "disk" ? (row.OSInternal === true ? true : null) : false,
      parentId,
      parentIds,
      mountpoint: clean(row.MountPoint),
      filesystem: clean(
        row.Content || (row.CapacityInUse !== undefined ? "apfs" : null),
      ),
      totalBytes: positive(row.Size) ?? 0,
      usedBytes: positive(row.CapacityInUse),
      availableBytes: null,
      scope: "host",
    };
    if (row.MountPoint) {
      try {
        const mounted = await volumeAt(row.MountPoint, { filesystem });
        disk.totalBytes = mounted.totalBytes;
        disk.availableBytes = mounted.availableBytes;
        // APFS reports the entire container's used space via statfs. Keep the
        // per-volume allocation from diskutil instead of repeating it as disk use.
        disk.usedBytes ??= mounted.usedBytes;
      } catch {
        /* Ejected volume. */
      }
    }
    disks.push(disk);
    for (const child of [
      ...(row.Partitions || []),
      ...(row.APFSVolumes || []),
    ].slice(0, 128))
      await walk(child, id);
  };
  for (const row of (result.AllDisksAndPartitions || []).slice(0, 128))
    await walk(row);
  return disks.slice(0, 128);
}
export async function windowsTelemetry(run = command) {
  // Fixed read-only CIM selectors; never enumerate process arguments or environment.
  const script =
    "$ErrorActionPreference='Stop'; $o=Get-CimInstance Win32_OperatingSystem; $p=@(Get-CimInstance Win32_PageFileUsage); $allocated=($p | Measure-Object AllocatedBaseSize -Sum).Sum; $used=($p | Measure-Object CurrentUsage -Sum).Sum; $d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace); $b=@(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus); [pscustomobject]@{MemoryTotal=([double]$o.TotalVisibleMemorySize*1024);MemoryFree=([double]$o.FreePhysicalMemory*1024);SwapTotal=([double]$allocated*1048576);SwapFree=([double]($allocated-$used)*1048576);Disks=$d;Battery=$b} | ConvertTo-Json -Depth 4 -Compress";
  const value = JSON.parse(
    await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]),
  );
  const total = positive(value.MemoryTotal),
    free = positive(value.MemoryFree);
  const swapTotal = positive(value.SwapTotal),
    swapFree = positive(value.SwapFree);
  const batteries = (
    Array.isArray(value.Battery) ? value.Battery : [value.Battery]
  ).filter(Boolean);
  const batteryLevels = batteries
    .map((battery) => positive(battery.EstimatedChargeRemaining))
    .filter((level) => level !== null && level <= 100);
  const batteryStates = batteries
    .map((battery) => positive(battery.BatteryStatus))
    .filter((status) => status !== null);
  return {
    memory:
      total === null || free === null
        ? null
        : {
            totalBytes: total,
            availableBytes: Math.min(total, free),
            usedBytes: Math.max(0, total - free),
          },
    swap: {
      supported: swapTotal !== null,
      totalBytes: swapTotal,
      usedBytes:
        swapTotal === null || swapFree === null
          ? null
          : Math.max(0, swapTotal - swapFree),
    },
    battery: batteries.length
      ? {
          level: batteryLevels.length
            ? batteryLevels.reduce((sum, level) => sum + level, 0) /
              batteryLevels.length
            : null,
          charging: batteryStates.some((status) =>
            [6, 7, 8, 9].includes(status),
          )
            ? true
            : batteryStates.length
              ? false
              : null,
        }
      : null,
    disks: (Array.isArray(value.Disks) ? value.Disks : [value.Disks])
      .filter(Boolean)
      .slice(0, 128)
      .map((row) => {
        const totalBytes = positive(row.Size);
        const availableBytes = positive(row.FreeSpace);
        return {
          id: `volume:${row.DeviceID}`,
          name: clean(row.VolumeName || row.DeviceID),
          kind: "volume",
          type: "volume",
          physical: false,
          parentId: null,
          parentIds: [],
          mountpoint: clean(row.DeviceID + "\\"),
          filesystem: clean(row.FileSystem),
          totalBytes,
          availableBytes,
          usedBytes:
            totalBytes === null || availableBytes === null
              ? null
              : Math.max(0, totalBytes - availableBytes),
          scope: "host",
        };
      }),
  };
}
