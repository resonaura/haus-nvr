import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  copyFile,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function cameraProcess(
  file,
  args,
  { signal, timeout = 15000, spawnProcess = spawn } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "",
      failed = false;
    const kill = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(kill, timeout);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", () => {
      failed = true;
    });
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > 1000000) kill();
      else output += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0 && !failed) resolve(output);
      else reject(new Error("camera_media_failed"));
    });
  });
}
export async function cameraMetadata(file, options) {
  const value = JSON.parse(
    await cameraProcess(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-count_packets",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,duration,nb_read_packets",
        "-of",
        "json",
        file,
      ],
      options,
    ),
  );
  const video = value.streams?.find((row) => row.codec_type === "video");
  return {
    audio:
      value.streams?.some(
        (row) => row.codec_type === "audio" && Number(row.nb_read_packets) > 0,
      ) === true,
    video: Boolean(video) && Number(video.nb_read_packets) > 0,
    width: video?.width,
    height: video?.height,
    duration: Number(value.format?.duration),
  };
}
const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Stream-copy ring: one local consumer of a shared producer, no camera credentials in FFmpeg. */
export class CameraRing {
  constructor(
    root,
    input,
    {
      spawnProcess = spawn,
      now = Date.now,
      probe = cameraMetadata,
      run = cameraProcess,
      maxBytes = 64 * 1024 ** 2,
      reserve = async () => () => {},
      requireAudio = true,
      recordAudio = true,
      retentionSeconds = 48,
      acquireFinalizer = () => () => {},
    } = {},
  ) {
    Object.assign(this, {
      root,
      input,
      spawnProcess,
      now,
      probe,
      run,
      maxBytes,
      reserve,
      requireAudio,
      recordAudio,
      retentionSeconds,
      acquireFinalizer,
    });
    this.abort = new AbortController();
    this.jobs = new Map();
    this.segments = [];
  }
  async start() {
    this.releaseRing = await this.reserve(this.maxBytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.startedAt = this.now();
    this.runIndex = 0;
    this.startReader();
  }
  startReader() {
    if (this.abort.signal.aborted || this.failed) return;
    const run = this.runIndex++;
    const runName = String(run).padStart(3, "0");
    const child = this.spawnProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "15000000",
        "-fflags",
        "+genpts",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "1000000",
        "-i",
        this.input,
        "-map",
        "0:v:0",
        ...(this.recordAudio ? ["-map", "0:a?"] : ["-an"]),
        "-c",
        "copy",
        "-copyinkf:a",
        "-f",
        "segment",
        "-segment_format",
        "mpegts",
        "-segment_time",
        "2",
        "-reset_timestamps",
        "1",
        "-segment_list",
        join(this.root, `segments-${runName}.csv`),
        "-segment_list_type",
        "csv",
        "-segment_list_size",
        "64",
        join(this.root, `${runName}%09d.ts`),
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    this.child = child;
    this.exit = new Promise((resolve) => child.once("close", resolve));
    child.on("error", () => {
      this.failed = true;
    });
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
      if (this.abort.signal.aborted || this.failed) return;
      this.scheduleReaderRestart();
    });
  }
  scheduleReaderRestart() {
    if (this.restartTimer || this.abort.signal.aborted || this.failed) return;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.readerRestarts ?? 0, 5));
    this.readerRestarts = (this.readerRestarts ?? 0) + 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.startReader();
    }, delay);
    this.restartTimer.unref?.();
  }
  async sample() {
    if (this.sampling) return this.sampling;
    this.sampling = this.collect().finally(() => {
      this.sampling = undefined;
    });
    return this.sampling;
  }
  async collect() {
    if (this.abort.signal.aborted) return;
    let ringBytes = 0;
    for (const name of await readdir(this.root).catch(() => []))
      if (/^(?:\d{9}|\d{12,})\.ts$/.test(name))
        ringBytes +=
          (await stat(join(this.root, name)).catch(() => null))?.size ?? 0;
    if (ringBytes > this.maxBytes * 1.1) {
      this.failed = true;
      this.child?.kill("SIGTERM");
      return;
    }
    const names = await readdir(this.root).catch(() => []);
    const lists = names.filter((name) => /^segments(?:-\d{3})?\.csv$/.test(name));
    const rows = [];
    for (const list of lists) {
      const csv = await readFile(join(this.root, list), "utf8").catch(() => "");
      for (const line of csv.split("\n")) {
        const match = /^(?:"?)(?:[^",]*\/)?((?:\d{9}|\d{12,})\.ts)(?:"?),([\d.]+),([\d.]+)$/.exec(line);
        if (!match) continue;
        const from = Number(match[2]), to = Number(match[3]);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 30) continue;
        const info = await stat(join(this.root, match[1])).catch(() => null);
        if (!info) continue;
        rows.push({ name: match[1], from, to, info });
      }
    }
    rows.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs || a.name.localeCompare(b.name));
    const latest = rows.at(-1);
    if (!latest) return;
    if (latest.name !== this.latestName) {
      this.latestName = latest.name;
      this.readerRestarts = 0;
      if (latest.info) {
        this.freshAt = latest.info.mtimeMs;
        if (!this.metadata || this.now() - (this.metadataAt ?? 0) > 5000) {
          this.metadata = await this.probe(join(this.root, latest.name), {
            signal: this.abort.signal,
          }).catch(() => undefined);
          this.metadataAt = this.now();
        }
      }
    }
    this.segments = rows.map((row) => ({
      ...row,
      // Segment mtime is the wall-clock time the writer closed it. Derive each
      // start from that file so a restarted RTSP reader's reset PTS cannot move
      // the timeline backwards or collide with an earlier segment.
      startAt: row.info.mtimeMs - (row.to - row.from) * 1000,
      endAt: row.info.mtimeMs,
    }));
    for (const job of this.jobs.values()) {
      if (job.state !== "recording") continue;
      for (const part of this.segments) {
        if (
          part.endAt <= job.startAt ||
          part.startAt >= job.endAt ||
          job.parts.has(part.name)
        )
          continue;
        const target = join(job.root, part.name);
        const info = await stat(join(this.root, part.name)).catch(() => null);
        if (!info) continue;
        if (job.bytes + info.size > job.maxBytes) {
          job.state = "failed";
          break;
        }
        await copyFile(join(this.root, part.name), target)
          .then(() => {
            job.parts.set(part.name, part);
            job.bytes += info.size;
          })
          .catch(() => {});
      }
      if (this.now() >= job.endAt + 2500 && !this.finalizing) {
        const release = this.acquireFinalizer();
        if (release) {
          this.finalizing = this.finalize(job).finally(() => {
            this.finalizing = undefined;
            release();
          });
          void this.finalizing.catch(() => {});
        }
      }
    }
    let bytes = 0;
    for (const part of [...this.segments].reverse()) {
      const file = join(this.root, part.name);
      const info = await stat(file).catch(() => null);
      bytes += info?.size ?? 0;
      if (
        this.now() - part.endAt > this.retentionSeconds * 1000 ||
        bytes > this.maxBytes
      )
        await rm(file, { force: true });
    }
    const retained = new Set(this.segments.map((part) => part.name));
    for (const name of await readdir(this.root))
      if (
        /^(?:\d{9}|\d{12,})\.ts$/.test(name) &&
        !retained.has(name) &&
        name !== this.latestName
      ) {
        const file = join(this.root, name);
        const info = await stat(file).catch(() => null);
        if (info && this.now() - info.mtimeMs > 10000)
          await rm(file, { force: true });
      }
    for (const job of this.jobs.values())
      if (
        ["ready", "failed"].includes(job.state) &&
        this.now() - job.createdAt > 900000
      )
        await this.removeRecording(job.id);
  }
  ready() {
    return (
      !this.failed &&
      this.metadata?.video === true &&
      (!this.requireAudio ||
        !this.recordAudio ||
        this.metadata.audio === true) &&
      this.now() - (this.metadataAt ?? 0) < 10000 &&
      this.now() - (this.freshAt ?? 0) < 10000
    );
  }
  async record(input) {
    const { eventId, startAt, endAt } = input;
    if (
      !/^[a-f0-9-]{36}$/.test(eventId) ||
      !Number.isSafeInteger(startAt) ||
      !Number.isSafeInteger(endAt) ||
      endAt <= startAt ||
      endAt - startAt > 330000 ||
      startAt > this.now() + 5000 ||
      startAt < this.now() - 330000 ||
      endAt > this.now() + 330000
    )
      throw new Error("invalid_camera_recording");
    let job = this.jobs.get(eventId);
    if (job) {
      if (job.state === "recording") {
        if (
          Math.max(job.endAt, endAt) - Math.min(job.startAt, startAt) >
          330000
        )
          throw new Error("invalid_camera_recording");
        job.startAt = Math.min(job.startAt, startAt);
        job.endAt = Math.max(job.endAt, endAt);
      }
      return this.describe(job);
    }
    if (!this.ready()) throw new Error("camera_ring_not_ready");
    if (
      [...this.jobs.values()].filter((row) =>
        ["recording", "preparing"].includes(row.state),
      ).length >= 2 ||
      this.jobs.size >= 16
    )
      throw new Error("camera_recording_busy");
    const root = join(this.root, `event-${eventId}`),
      maxBytes = 512 * 1024 ** 2;
    const release = await this.reserve(maxBytes * 2);
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      release();
      throw error;
    }
    job = {
      id: eventId,
      root,
      startAt,
      endAt,
      state: "recording",
      parts: new Map(),
      createdAt: this.now(),
      bytes: 0,
      maxBytes,
      release,
    };
    this.jobs.set(eventId, job);
    await this.sample();
    return this.describe(job);
  }
  async finalize(job) {
    job.state = "preparing";
    try {
      const parts = [...job.parts.values()].sort(
        (a, b) => a.startAt - b.startAt,
      );
      if (
        !parts.length ||
        parts[0].startAt > job.startAt + 3000 ||
        parts.at(-1).endAt < job.endAt - 3000 ||
        parts.some(
          (part, index) =>
            index > 0 && part.startAt - parts[index - 1].endAt > 500,
        )
      )
        throw new Error("camera_recording_incomplete");
      const list = join(job.root, "input.txt");
      await writeFile(
        list,
        parts.map((part) => `file '${part.name}'`).join("\n"),
        { mode: 0o600 },
      );
      const output = join(job.root, "recording.mp4");
      await this.run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-protocol_whitelist",
          "file",
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          list,
          "-map",
          "0:v:0",
          ...(this.recordAudio ? ["-map", "0:a?"] : ["-an"]),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-movflags",
          "+faststart",
          output,
        ],
        { signal: this.abort.signal, timeout: 60000 },
      );
      const metadata = await this.probe(output, { signal: this.abort.signal });
      const info = await stat(output);
      if (
        (this.requireAudio && this.recordAudio && !metadata.audio) ||
        !metadata.video ||
        !Number.isFinite(metadata.duration) ||
        Math.abs(
          metadata.duration - (parts.at(-1).endAt - parts[0].startAt) / 1000,
        ) > Math.max(1, metadata.duration * 0.05) ||
        info.size > job.maxBytes
      )
        throw new Error("camera_recording_incomplete");
      job.result = {
        bytes: info.size,
        sha256: await digest(output),
        duration: metadata.duration,
        mediaStartAt: Math.round(parts[0].startAt),
        audio: metadata.audio,
      };
      job.output = output;
      job.state = "ready";
      job.completedAt = this.now();
      for (const part of parts)
        await rm(join(job.root, part.name), { force: true });
      await rm(list, { force: true });
    } catch {
      job.state = "failed";
      await rm(job.root, { recursive: true, force: true });
    }
  }
  describe(job) {
    return {
      id: job.id,
      state: job.state,
      ...(job.result ?? {}),
      ...(job.state === "failed" ? { error: "camera_recording_failed" } : {}),
    };
  }
  async removeRecording(id) {
    const job = this.jobs.get(id);
    if (!job || job.state === "preparing") return;
    this.jobs.delete(id);
    await rm(job.root, { recursive: true, force: true });
    job.release?.();
  }
  async stop() {
    this.abort.abort();
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      await this.exit;
      clearTimeout(kill);
    }
    await Promise.allSettled([this.sampling, this.finalizing]);
    for (const job of this.jobs.values()) job.release?.();
    this.releaseRing?.();
    await rm(this.root, { recursive: true, force: true });
  }
}
