import { readFile, statfs } from "node:fs/promises";
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
const clean = (value, length = 240) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, length)
    : null;
const positive = (value) =>
  value !== null && Number.isFinite(Number(value)) && Number(value) >= 0
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
        "NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,LABEL,MODEL,TRAN,SUBSYSTEMS",
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
      // Retain the coarse protocol-1 kind for older clients. Only whole disks
      // belong to it; partitions and mapped storage must not inflate disk counts.
      const disk = {
        id,
        name: clean(row.label || row.model?.trim() || row.name),
        kind: type === "disk" ? "disk" : "volume",
        type,
        physical,
        parentId,
        parentIds: parentId ? [parentId] : [],
        mountpoint: null,
        filesystem: clean(row.fstype),
        totalBytes: positive(row.size) ?? 0,
        usedBytes: null,
        availableBytes: null,
        scope: "host",
      };
      seen.set(id, disk);
      disks.push(disk);
      for (const mount of mounts.slice(0, 16)) {
        if (disks.length >= 128) break;
        if (seen.has(`volume:${mount}`)) continue;
        try {
          const volume = await volumeAt(mount, {
            filesystem,
            parentId: id,
            name: row.label || mount,
            filesystemType: row.fstype,
          });
          seen.set(volume.id, volume);
          disks.push(volume);
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
    "$ErrorActionPreference='Stop'; $o=Get-CimInstance Win32_OperatingSystem; $p=@(Get-CimInstance Win32_PageFileUsage); $allocated=($p | Measure-Object AllocatedBaseSize -Sum).Sum; $used=($p | Measure-Object CurrentUsage -Sum).Sum; $d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace); [pscustomobject]@{MemoryTotal=([double]$o.TotalVisibleMemorySize*1024);MemoryFree=([double]$o.FreePhysicalMemory*1024);SwapTotal=([double]$allocated*1048576);SwapFree=([double]$allocated-[double]$used)*1048576;Disks=$d} | ConvertTo-Json -Depth 4 -Compress";
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
    disks: (Array.isArray(value.Disks) ? value.Disks : [value.Disks])
      .filter(Boolean)
      .slice(0, 128)
      .map((row) => ({
        id: `volume:${row.DeviceID}`,
        name: clean(row.VolumeName || row.DeviceID),
        kind: "volume",
        type: "volume",
        physical: false,
        parentId: null,
        parentIds: [],
        mountpoint: clean(row.DeviceID + "\\"),
        filesystem: clean(row.FileSystem),
        totalBytes: positive(row.Size) ?? 0,
        availableBytes: positive(row.FreeSpace),
        usedBytes: Math.max(
          0,
          (positive(row.Size) ?? 0) - (positive(row.FreeSpace) ?? 0),
        ),
        scope: "host",
      })),
  };
}
