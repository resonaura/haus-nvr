import { availableParallelism, totalmem } from "node:os";
import { readFile } from "node:fs/promises";

/** Respect container quotas, not just the host's CPU count and installed RAM. */
export class Capacity {
  constructor({
    read = readFile,
    cpus = availableParallelism(),
    memory = totalmem(),
    maxStreams,
  } = {}) {
    this.read = async (name) =>
      String(await read(`/sys/fs/cgroup/${name}`, "utf8").catch(() => ""));
    this.readHost = async (name) =>
      String(await read(`/proc/pressure/${name}`, "utf8").catch(() => ""));
    this.cpus = cpus;
    this.memory = memory;
    this.requestedStreams = maxStreams;
    this.memoryUsed = 0;
    this.cpu = 0;
  }
  async initialize() {
    const [quota, memory] = await Promise.all([
      this.read("cpu.max"),
      this.read("memory.max"),
    ]);
    const [amount, period] = quota.trim().split(/\s+/).map(Number);
    if (amount > 0 && period > 0)
      this.cpus = Math.min(this.cpus, amount / period);
    if (Number(memory) > 0) this.memory = Math.min(this.memory, Number(memory));
    if (
      this.requestedStreams !== undefined &&
      (!Number.isInteger(this.requestedStreams) ||
        this.requestedStreams < 1 ||
        this.requestedStreams > 32)
    )
      throw new Error("Invalid stream budget");
    this.streams = Math.min(
      this.requestedStreams ?? 4,
      Math.max(1, Math.floor(this.cpus * 2)),
      Math.max(1, Math.floor(this.memory / (256 * 1024 ** 2))),
    );
    // One inference process per weak node; leave capacity for recording and playback.
    this.detectors =
      this.memory >= 384 * 1024 ** 2 && this.cpus >= 0.5
        ? Math.max(
            1,
            Math.min(
              2,
              Math.floor(this.cpus / 2),
              Math.floor(this.memory / (512 * 1024 ** 2)),
            ),
          )
        : 0;
    await this.sample();
    this.timer = setInterval(() => void this.sample(), 5000);
    this.timer.unref();
    return this;
  }
  async sample() {
    const [memory, stats, cpu, memoryPressure, ioPressure] = await Promise.all([
      this.read("memory.current"),
      this.read("memory.stat"),
      this.read("cpu.stat"),
      this.readHost("memory"),
      this.readHost("io"),
    ]);
    const full = (value) => {
      const match = /^full\s+avg10=(\d+(?:\.\d+)?)\s/m.exec(value);
      const percent = match ? Number(match[1]) : NaN;
      return Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? percent
        : null;
    };
    this.hostPressure = {
      memoryFull: full(memoryPressure),
      ioFull: full(ioPressure),
    };
    if (memory.trim() && Number(memory) >= 0) {
      // cgroup usage includes disk page cache from recording replication. Only
      // subtract inactive file pages; anonymous memory, tmpfs and active pages
      // still count against the worker budget.
      this.memoryCurrent = Number(memory);
      const inactiveFile =
        Number(/^inactive_file (\d+)$/m.exec(stats)?.[1]) || 0;
      this.memoryUsed = Math.max(0, this.memoryCurrent - inactiveFile);
    }
    const usage = Number(/\busage_usec (\d+)/.exec(cpu)?.[1]);
    const now = performance.now();
    if (Number.isFinite(usage) && this.last)
      this.cpu = Math.max(
        0,
        Math.min(
          1,
          (usage - this.last.usage) / ((now - this.last.at) * 1000 * this.cpus),
        ),
      );
    if (Number.isFinite(usage)) this.last = { usage, at: now };
  }
  get pressured() {
    return this.memoryUsed / this.memory > 0.85 || this.cpu > 0.9;
  }
  get analysisPressured() {
    // Optional inference yields to actual whole-host swapping/I/O stalls even
    // when its own container has spare quota. Existing camera rings keep running.
    return (
      this.pressured ||
      (this.hostPressure?.memoryFull ?? 0) >= 5 ||
      (this.hostPressure?.ioFull ?? 0) >= 20
    );
  }
  status() {
    return {
      cpus: this.cpus,
      memoryBytes: this.memory,
      memoryUsedBytes: this.memoryUsed,
      memoryCurrentBytes: this.memoryCurrent ?? this.memoryUsed,
      cpu: this.cpu,
      pressured: this.pressured,
      analysisPressured: this.analysisPressured,
      hostPressure: this.hostPressure,
    };
  }
  stop() {
    clearInterval(this.timer);
  }
}
