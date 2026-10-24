import { stat } from "node:fs/promises";
import { command } from "./service-telemetry.mjs";

const windowsPowerShell =
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** Match this exact running distribution, its registered VHD and hosting volume. */
export async function wslStorageBacking({
  run = command,
  inspect = stat,
  now = Date.now,
} = {}) {
  const root = (await run("/usr/bin/wslpath", ["-w", "/"])).trim();
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\\r\n]{1,80})\\?$/i.exec(
    root,
  );
  if (!match) throw new Error("wsl_distribution_unknown");
  const name = Buffer.from(match[1], "utf8").toString("base64");
  const device = (await inspect("/")).dev;
  const sampledAt = now();
  const script = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
$name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name}'));
$items=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | Where-Object {$_.GetValue('DistributionName') -ceq $name});
if($items.Count -ne 1){throw 'Distribution mapping unavailable'};
$item=$items[0];$base=$item.GetValue('BasePath') -replace '^\\\\\\?\\','';
$filename=$item.GetValue('VhdFileName');if(-not $filename){$filename='ext4.vhdx'};
$file=[IO.Path]::Combine($base,$filename);
if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Distribution image unavailable'};
$volumes=@(Get-Volume -FilePath $file -ErrorAction Stop);
if($volumes.Count -ne 1){throw 'Backing volume ambiguous'};
$volume=$volumes[0];
[pscustomobject]@{AvailableBytes=$volume.SizeRemaining;TotalBytes=$volume.Size;Volume=$(if($volume.DriveLetter){[string]$volume.DriveLetter+':'}else{'Windows volume'})} | ConvertTo-Json -Compress
`;
  const output = await run(
    windowsPowerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 8000, maxBuffer: 16384 },
  );
  const value = JSON.parse(output.replace(/^\uFEFF/, ""));
  return sanitizeStorageBacking(
    {
      source: "wsl-vhd",
      device,
      sampledAt: new Date(sampledAt).toISOString(),
      availableBytes: value.AvailableBytes,
      totalBytes: value.TotalBytes,
      volume: value.Volume,
    },
    now(),
  );
}

export function sanitizeStorageBacking(value, now = Date.now()) {
  const sampled = Date.parse(value?.sampledAt);
  if (
    value?.source !== "wsl-vhd" ||
    !Number.isSafeInteger(value.device) ||
    value.device < 0 ||
    !Number.isFinite(sampled) ||
    now - sampled > 30000 ||
    sampled - now > 1000 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes <= 0 ||
    !Number.isSafeInteger(value.availableBytes) ||
    value.availableBytes < 0 ||
    value.availableBytes > value.totalBytes
  )
    throw new Error("invalid_storage_backing");
  return {
    source: "wsl-vhd",
    device: value.device,
    sampledAt: new Date(sampled).toISOString(),
    totalBytes: value.totalBytes,
    availableBytes: value.availableBytes,
    volume: /^[A-Z]:$/i.test(value.volume ?? "")
      ? value.volume.toUpperCase()
      : "Windows volume",
  };
}

/** A device-number match ties the mounted data filesystem to this exact VHD. */
export class StorageBacking {
  constructor(
    root,
    sample,
    { inspect = stat, now = Date.now, required = false } = {},
  ) {
    Object.assign(this, { root, sample, inspect, now });
    this.startedAt = now();
    this.confirmed = required;
    this.lastSample = -Infinity;
  }
  async capacity() {
    const report = this.sample();
    const device = (await this.inspect(this.root)).dev;
    let backing;
    try {
      backing = sanitizeStorageBacking(report?.storageBacking, this.now());
    } catch {}
    if (backing && backing.device === device) {
      this.confirmed = true;
      const sampled = Date.parse(backing.sampledAt);
      if (sampled >= this.startedAt && sampled >= this.lastSample) {
        this.lastSample = sampled;
        return { state: "fresh", ...backing };
      }
    }
    // Once a matching native backing volume is known, stale data or a mount
    // change cannot restore the misleading sparse filesystem capacity.
    return this.confirmed
      ? { state: "unavailable", source: "wsl-vhd", availableBytes: 0 }
      : null;
  }
}
