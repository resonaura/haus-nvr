import { command } from "./service-telemetry.mjs";
const text = (value, length = 200) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, "")
        .trim()
        .slice(0, length)
    : "";
const unavailable = () => ({
  gpus: { available: false, source: "unavailable", adapters: [] },
});
export function sanitizeHardware(value) {
  const os = value?.operatingSystem;
  const operatingSystem =
    os &&
    ((os.source === "windows-cim" && os.platform === "win32") ||
      (os.source === "macos-system-profiler" && os.platform === "darwin")) &&
    text(os.name)
      ? {
          name: text(os.name),
          version: text(os.version, 80),
          build: text(os.build, 80),
          architecture: text(os.architecture, 40),
          platform: os.platform === "win32" ? "win32" : "darwin",
          source: os.source,
        }
      : null;
  const input = value?.gpus;
  const gpus =
    input?.available === true &&
    ["windows-cim", "linux-pci", "macos-system-profiler"].includes(input.source)
      ? {
          available: true,
          source: input.source,
          sampledAt: text(input.sampledAt, 40),
          adapters: (Array.isArray(input.adapters) ? input.adapters : [])
            .slice(0, 16)
            .filter((a) => a && text(a.name))
            .map((a, index) => ({
              id: text(a.id, 80) || "gpu:" + index,
              name: text(a.name),
              vendor: text(a.vendor, 120) || null,
              driver: text(a.driver, 120) || null,
              kind: ["integrated", "discrete", "external", "software"].includes(
                a.kind,
              )
                ? a.kind
                : null,
              memoryBytes:
                Number.isSafeInteger(a.memoryBytes) && a.memoryBytes >= 0
                  ? a.memoryBytes
                  : null,
            })),
        }
      : unavailable().gpus;
  return { ...(operatingSystem ? { operatingSystem } : {}), gpus };
}

export function parseWindowsHardware(
  input,
  sampledAt = new Date().toISOString(),
) {
  const os = input?.OperatingSystem;
  return sanitizeHardware({
    operatingSystem: os
      ? {
          name: os.Caption,
          version: os.Version,
          build: os.BuildNumber,
          architecture: os.OSArchitecture,
          platform: "win32",
          source: "windows-cim",
        }
      : null,
    gpus: {
      available: Array.isArray(input?.GPUs),
      source: "windows-cim",
      sampledAt,
      adapters: (Array.isArray(input?.GPUs) ? input.GPUs : []).map(
        (gpu, index) => ({
          id: "windows-gpu:" + index,
          name: gpu.Name,
          vendor: gpu.AdapterCompatibility,
          driver: gpu.DriverVersion,
          kind: null,
          memoryBytes: null,
        }),
      ),
    },
  });
}
export function parseLinuxGpus(output, sampledAt = new Date().toISOString()) {
  const adapters = String(output)
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const fields = Object.fromEntries(
        block.split("\n").flatMap((line) => {
          const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
          return match ? [[match[1], match[2]]] : [];
        }),
      );
      if (!/\[03(?:00|02|80)\]/.test(fields.Class ?? "") || !fields.Device)
        return [];
      return [
        {
          id: text(fields.Slot, 80),
          name: text(fields.Device),
          vendor: text(fields.Vendor),
          driver: text(fields.Driver),
          kind: null,
          memoryBytes: null,
        },
      ];
    });
  return sanitizeHardware({
    gpus: { available: true, source: "linux-pci", sampledAt, adapters },
  }).gpus;
}

export async function hostHardware({
  platform,
  wsl = false,
  run = command,
  now = Date.now,
} = {}) {
  const sampledAt = new Date(now()).toISOString();
  if (platform === "win32" || wsl) {
    // AdapterRAM is uint32 and can truncate modern VRAM. Do not report it as
    // dedicated memory, or infer integrated/discrete from reserved/shared RAM.
    const script =
      "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$os=$null;try{$os=Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 3 | Select-Object Caption,Version,BuildNumber,OSArchitecture}catch{};$g=$null;try{$g=@(Get-CimInstance Win32_VideoController -OperationTimeoutSec 3 | Select-Object -First 16 Name,AdapterCompatibility,DriverVersion)}catch{};[pscustomobject]@{OperatingSystem=$os;GPUs=$g}|ConvertTo-Json -Depth 4 -Compress";
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
      { timeout: 8000, maxBuffer: 64 * 1024 },
    );
    return parseWindowsHardware(
      JSON.parse(output.replace(/^\uFEFF/, "")),
      sampledAt,
    );
  }
  if (platform === "linux") {
    const output = await run("lspci", ["-vmm", "-D", "-nn", "-k"], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    return { gpus: parseLinuxGpus(output, sampledAt) };
  }
  return unavailable();
}
