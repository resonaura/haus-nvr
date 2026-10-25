import { command } from "./service-telemetry.mjs";
import { spawn } from "node:child_process";

const nonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, "")
        .trim()
        .slice(0, 240)
    : "";

export function parseWindowsResources(value) {
  const total = nonnegative(value?.MemoryTotal);
  const available = nonnegative(value?.MemoryAvailable);
  const processors = (
    Array.isArray(value?.Processors) ? value.Processors : [value?.Processors]
  )
    .filter(Boolean)
    .slice(0, 128);
  const counts = processors.map((cpu) => cpu.NumberOfLogicalProcessors);
  if (
    !total ||
    available === null ||
    available > total ||
    !counts.length ||
    !counts.every((count) => Number.isSafeInteger(count) && count > 0)
  )
    throw new Error("windows_resources_unavailable");
  const usage = nonnegative(value.CpuPercent);
  const pagefile = value.PageFileAvailable === true;
  const swapTotal = pagefile ? nonnegative(value.SwapTotal) : null;
  const swapUsed = pagefile ? nonnegative(value.SwapUsed) : null;
  return {
    cpu: {
      model:
        [
          ...new Set(processors.map((cpu) => text(cpu.Name)).filter(Boolean)),
        ].join(" · ") || null,
      logicalCores: counts.reduce((sum, count) => sum + count, 0),
      usage: usage !== null && usage <= 100 ? usage / 100 : null,
      loadAverage: [],
    },
    memory: {
      totalBytes: total,
      availableBytes: available,
      usedBytes: total - available,
    },
    swap: {
      supported:
        pagefile &&
        swapTotal !== null &&
        swapUsed !== null &&
        swapUsed <= swapTotal,
      totalBytes: swapTotal,
      usedBytes:
        swapTotal !== null && swapUsed !== null && swapUsed <= swapTotal
          ? swapUsed
          : null,
    },
    uptimeSeconds: nonnegative(value.UptimeSeconds),
  };
}

const resourceScript =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$o=Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime -OperationTimeoutSec 2;$mt=$null;$ma=$null;if($null-ne$o.TotalVisibleMemorySize){$mt=[double]$o.TotalVisibleMemorySize*1024};if($null-ne$o.FreePhysicalMemory){$ma=[double]$o.FreePhysicalMemory*1024};$p=@(Get-CimInstance Win32_Processor -Property Name,NumberOfLogicalProcessors -OperationTimeoutSec 2 | Select-Object Name,NumberOfLogicalProcessors);$c=$null;try{$c=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -Property PercentProcessorTime -OperationTimeoutSec 2).PercentProcessorTime}catch{};$page=$null;$pageOk=$false;try{$page=@(Get-CimInstance Win32_PageFileUsage -Property AllocatedBaseSize,CurrentUsage -OperationTimeoutSec 2);$pageOk=$true}catch{};$st=$null;$su=$null;if($pageOk){$st=[double](($page|Measure-Object -Property AllocatedBaseSize -Sum).Sum)*1048576;$su=[double](($page|Measure-Object -Property CurrentUsage -Sum).Sum)*1048576};$up=$null;if($null-ne$o.LastBootUpTime){$up=[Math]::Floor(([DateTime]::UtcNow-$o.LastBootUpTime.ToUniversalTime()).TotalSeconds)};[pscustomobject]@{MemoryTotal=$mt;MemoryAvailable=$ma;Processors=$p;CpuPercent=$c;PageFileAvailable=$pageOk;SwapTotal=$st;SwapUsed=$su;UptimeSeconds=$up}|ConvertTo-Json -Depth 4 -Compress";

/** The same native, language-independent CIM selectors work with or without WSL. */
export async function windowsResources({ run = command, wsl = false } = {}) {
  const output = await run(
    wsl
      ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
      : "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(resourceScript, "utf16le").toString("base64"),
    ],
    { timeout: 10000, maxBuffer: 64 * 1024 },
  );
  return parseWindowsResources(JSON.parse(output.replace(/^\uFEFF/, "")));
}

/** One warm native reader avoids launching PowerShell for every live second. */
export class WindowsResourceSampler {
  constructor({ wsl = false, now = Date.now, launch = spawn } = {}) {
    Object.assign(this, { wsl, now, launch });
    this.waiters = new Set();
    this.retryAt = 0;
  }
  start() {
    if (this.child || this.stopped || this.now() < this.retryAt) return;
    const loop = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$closed=[Console]::In.ReadLineAsync();while(-not $closed.IsCompleted){$tick=[Diagnostics.Stopwatch]::StartNew();try{${resourceScript}}catch{[Console]::WriteLine('{"error":"native_resources_unavailable"}')};[Console]::Out.Flush();$remaining=1000-$tick.ElapsedMilliseconds;if($remaining-gt 0){Start-Sleep -Milliseconds $remaining}}`;
    const child = this.launch(
      this.wsl
        ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        : "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(loop, "utf16le").toString("base64"),
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 65536) {
        child.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer
          .slice(0, end)
          .replace(/^\uFEFF/, "")
          .trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const value = parseWindowsResources(JSON.parse(line));
          this.value = { ...value, sampledAt: this.now() };
          for (const waiter of this.waiters) waiter.resolve(this.value);
          this.waiters.clear();
        } catch {
          // Never publish a partial/invalid native sample or retime an old one.
        }
      }
    });
    const closed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.retryAt = this.now() + 5000;
      for (const waiter of this.waiters)
        waiter.reject(new Error("windows_resources_unavailable"));
      this.waiters.clear();
    };
    child.once("error", closed);
    child.once("exit", closed);
  }
  async read() {
    if (this.stopped) throw new Error("windows_resources_unavailable");
    this.start();
    if (this.value && this.now() - this.value.sampledAt <= 2500)
      return this.value;
    if (this.value || !this.child)
      throw new Error("windows_resources_unavailable");
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        this.child?.kill();
        reject(new Error("windows_resources_unavailable"));
      }, 10000);
      this.waiters.add(waiter);
    });
  }
  stop() {
    this.stopped = true;
    this.child?.stdin.end();
    this.child?.kill();
    for (const waiter of this.waiters)
      waiter.reject(new Error("windows_resources_unavailable"));
    this.waiters.clear();
  }
}
