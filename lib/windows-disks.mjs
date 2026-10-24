import { command } from "./service-telemetry.mjs";

// Fixed, read-only CIM relationships preserve the native Windows disk tree.
// No serial numbers, registry, shell input or user-provided selectors.
const script = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
$drives=@(Get-CimInstance Win32_DiskDrive -OperationTimeoutSec 3 | Select-Object -First 32);
$disks=@(foreach($drive in $drives){
  $parts=@();try{$parts=@(Get-Partition -DiskNumber $drive.Index -ErrorAction Stop | Select-Object -First 128)}catch{};
  if($parts.Count -eq 0){$parts=@(Get-CimAssociatedInstance -InputObject $drive -Association Win32_DiskDriveToDiskPartition -OperationTimeoutSec 3 | Select-Object -First 128)};
  [pscustomobject]@{Index=$drive.Index;Model=$drive.Model;Size=$drive.Size;Partitions=@(foreach($part in $parts){
    if($part.PartitionNumber){
      $volume=$null;try{$volume=Get-Volume -Partition $part -ErrorAction Stop | Select-Object -First 1}catch{};
      $volumes=@();if($part.DriveLetter -and [int]$part.DriveLetter -gt 0 -and $volume){$volumes=@([pscustomobject]@{DeviceID=([string]$part.DriveLetter+':');VolumeName=$volume.FileSystemLabel;FileSystem=$volume.FileSystem;Size=$volume.Size;FreeSpace=$volume.SizeRemaining})};
      [pscustomobject]@{Index=($part.PartitionNumber-1);Number=$part.PartitionNumber;Size=$part.Size;GptType=$part.GptType;ReadOnly=$part.IsReadOnly;FileSystem=$volume.FileSystem;VolumeSize=$volume.Size;FreeSpace=$volume.SizeRemaining;Volumes=$volumes}
    }else{
      $volumes=@(Get-CimAssociatedInstance -InputObject $part -Association Win32_LogicalDiskToPartition -OperationTimeoutSec 3 | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace);
      [pscustomobject]@{Index=$part.Index;Number=($part.Index+1);Size=$part.Size;Volumes=$volumes}
    }
  })}
});
[pscustomobject]@{Disks=$disks} | ConvertTo-Json -Depth 7 -Compress
`;
const rows = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const count = (value) =>
  value !== null &&
  value !== undefined &&
  String(value).trim() !== "" &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, "")
        .trim()
        .slice(0, 160)
    : "";
const partitionRoles = {
  "c12a7328-f81f-11d2-ba4b-00a0c93ec93b": ["efi", "EFI System Partition"],
  "e3c9e316-0b5c-4db8-817d-f92df00215ae": ["reserved", "Microsoft Reserved"],
  "de94bba4-06d1-4d40-a16a-bfd50179d6ac": ["recovery", "Windows Recovery"],
  "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7": ["data", null],
};

export function parseWindowsDisks(value) {
  const disks = new Map();
  for (const drive of rows(value?.Disks).slice(0, 32)) {
    const index = count(drive?.Index);
    if (index === null || !drive || typeof drive !== "object") continue;
    const id = `windows-disk:${index}`,
      model = text(drive.Model);
    disks.set(id, {
      id,
      name: model || `Disk ${index}`,
      kind: "disk",
      type: "disk",
      physical: model
        ? !/(?:virtual|vhd|qemu|vmware|virtio|xen|storage space)/i.test(model)
        : null,
      parentId: null,
      parentIds: [],
      mountpoint: null,
      filesystem: null,
      totalBytes: count(drive.Size),
      usedBytes: null,
      availableBytes: null,
      scope: "host",
    });
    for (const part of rows(drive.Partitions).slice(0, 128)) {
      const partition = count(part?.Index);
      if (partition === null) continue;
      const partId = `${id}:partition:${partition}`;
      const purpose =
        partitionRoles[
          String(part.GptType ?? "")
            .toLowerCase()
            .replace(/[{}]/g, "")
        ];
      const volumeSize = count(part.VolumeSize),
        free = count(part.FreeSpace);
      disks.set(partId, {
        id: partId,
        name:
          purpose?.[1] || `Partition ${count(part.Number) || partition + 1}`,
        kind: "volume",
        type: "partition",
        physical: false,
        parentId: id,
        parentIds: [id],
        mountpoint: null,
        filesystem: text(part.FileSystem) || null,
        partitionNumber: count(part.Number) || partition + 1,
        ...(purpose ? { partitionRole: purpose[0] } : {}),
        ...(typeof part.ReadOnly === "boolean"
          ? { readOnly: part.ReadOnly }
          : {}),
        totalBytes: count(part.Size),
        usedBytes:
          volumeSize === null || free === null
            ? null
            : Math.max(0, volumeSize - free),
        availableBytes: free,
        scope: "host",
      });
      for (const row of rows(part.Volumes).slice(0, 128)) {
        if (!/^[A-Z]:$/i.test(row?.DeviceID ?? "")) continue;
        const letter = row.DeviceID.toUpperCase(),
          volumeId = `windows-volume:${letter}`;
        const existing = disks.get(volumeId);
        if (existing) {
          if (!existing.parentIds.includes(partId))
            existing.parentIds.push(partId);
          continue;
        }
        const totalBytes = count(row.Size),
          availableBytes = count(row.FreeSpace);
        disks.set(volumeId, {
          id: volumeId,
          name: text(row.VolumeName)
            ? `${text(row.VolumeName)} (${letter})`
            : letter,
          kind: "volume",
          type: "volume",
          physical: false,
          parentId: partId,
          parentIds: [partId],
          mountpoint: `${letter}\\`,
          filesystem: text(row.FileSystem) || null,
          totalBytes,
          availableBytes,
          usedBytes:
            totalBytes === null || availableBytes === null
              ? null
              : Math.max(0, totalBytes - availableBytes),
          scope: "host",
        });
      }
    }
  }
  return [...disks.values()].slice(0, 128);
}

export async function windowsDisks({ run = command, wsl = false } = {}) {
  const output = await run(
    wsl
      ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
      : "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 8000, maxBuffer: 512 * 1024 },
  );
  const disks = parseWindowsDisks(JSON.parse(output.replace(/^\uFEFF/, "")));
  if (!disks.some((disk) => disk.type === "disk" && disk.totalBytes > 0))
    throw new Error("windows_disks_unavailable");
  return disks;
}
