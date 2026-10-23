import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { blobPath } from "./blobs.mjs";
import { body, json } from "./http.mjs";
import { normalizeRecording } from "./playback-process.mjs";

/** Optional bounded work on an existing authenticated blob; the helper owns the result. */
export class Playback {
  constructor(
    root,
    blobs,
    capacity,
    {
      encode = normalizeRecording,
      now = () => performance.now(),
      maxBytes = 256 * 1024 ** 2,
    } = {},
  ) {
    this.root = root;
    this.blobs = blobs;
    this.capacity = capacity;
    this.encode = encode;
    this.now = now;
    this.maxBytes = maxBytes;
    this.jobs = new Map();
    this.serving = 0;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root))
      if (/^[a-f0-9-]{36}$/.test(name))
        await rm(join(this.root, name), { recursive: true, force: true });
    this.timer = setInterval(() => void this.prune().catch(() => {}), 5000);
    this.timer.unref();
  }
  status() {
    return {
      profile: 1,
      active: [...this.jobs.values()].filter((j) => j.state === "preparing")
        .length,
      max:
        !this.stopped &&
        !this.capacity.pressured &&
        this.capacity.cpus >= 1 &&
        this.capacity.memory >= 768 * 1024 ** 2 &&
        this.capacity.memory - (this.capacity.memoryUsed || 0) >=
          512 * 1024 ** 2
          ? 1
          : 0,
    };
  }
  describe(job) {
    return {
      id: job.id,
      status: job.state,
      ...(job.result || {}),
      ...(job.state === "failed" ? { error: "preparation_failed" } : {}),
    };
  }
  start(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["digest", "profile", "audioTrimSeconds"].includes(k),
      ) ||
      !/^[a-f0-9]{64}$/.test(input.digest) ||
      input.profile !== 1 ||
      !Number.isFinite(input.audioTrimSeconds) ||
      input.audioTrimSeconds < 0 ||
      input.audioTrimSeconds > 600
    )
      throw new Error("invalid_playback");
    if (this.stopped) throw new Error("playback_busy");
    const identity = JSON.stringify([
      input.digest,
      input.profile,
      input.audioTrimSeconds,
    ]);
    const known = [...this.jobs.values()].find((j) => j.identity === identity);
    if (known) return this.describe(known);
    const budget = this.status();
    if (budget.active >= budget.max || this.jobs.size >= 8)
      throw new Error("playback_busy");
    const id = randomUUID();
    const job = {
      id,
      identity,
      state: "preparing",
      lastRead: this.now(),
      abort: new AbortController(),
      dir: join(this.root, id),
    };
    job.output = join(job.dir, "playback.mp4");
    this.jobs.set(id, job);
    this.capacity.playbackBusy = true;
    job.pending = this.work(job, input);
    return this.describe(job);
  }
  async work(job, input) {
    let reader;
    try {
      reader = await this.blobs.openRead(input.digest);
      const info = reader.info;
      if (!info.isFile() || info.size <= 0 || info.size > 512 * 1024 ** 2)
        throw new Error("invalid_media");
      job.release = await this.blobs.reserveTransient(this.maxBytes);
      job.abort.signal.throwIfAborted();
      await mkdir(job.dir, { mode: 0o700 });
      job.abort.signal.throwIfAborted();
      const result = await this.encode({
        input: blobPath(this.blobs.root, input.digest),
        output: job.output,
        audioTrimSeconds: input.audioTrimSeconds,
        maxBytes: this.maxBytes,
        signal: job.abort.signal,
        memoryBudget: Math.max(
          0,
          this.capacity.memory * 0.8 - (this.capacity.memoryUsed || 0),
        ),
      });
      job.abort.signal.throwIfAborted();
      const bytes = (await stat(job.output)).size;
      if (!bytes || bytes > this.maxBytes)
        throw new Error("invalid_prepared_media");
      await chmod(job.output, 0o600);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(job.output)) {
        job.abort.signal.throwIfAborted();
        hash.update(chunk);
      }
      job.result = { ...result, digest: hash.digest("hex"), bytes, profile: 1 };
      job.state = "ready";
      job.lastRead = this.now();
    } catch {
      job.state = "failed";
      job.lastRead = this.now();
      await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      job.release?.();
    } finally {
      try {
        await reader?.close();
      } finally {
        this.capacity.playbackBusy = false;
      }
    }
  }
  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.abort.abort();
    await job.pending;
    await rm(job.dir, { recursive: true, force: true });
    job.release?.();
    this.jobs.delete(id);
  }
  async prune() {
    for (const job of this.jobs.values())
      if (
        !job.serving &&
        this.now() - job.lastRead > (job.state === "failed" ? 5000 : 900000)
      )
        await this.remove(job.id);
  }
  async handle(req, res, path) {
    if (path === "/v1/playback" && req.method === "POST") {
      const result = this.start(await body(req));
      json(
        res,
        result.status === "ready"
          ? 200
          : result.status === "failed"
            ? 503
            : 202,
        result,
      );
      return true;
    }
    const match = /^\/v1\/playback\/([a-f0-9-]{36})(\/media)?$/.exec(path);
    if (!match) return false;
    const job = this.jobs.get(match[1]);
    if (!job) {
      json(res, 404, { error: "not_found" });
      return true;
    }
    job.lastRead = this.now();
    if (!match[2] && req.method === "DELETE") {
      await this.remove(job.id);
      json(res, 200, { deleted: true });
      return true;
    }
    if (!match[2] && req.method === "GET") {
      json(
        res,
        job.state === "failed" ? 503 : job.state === "ready" ? 200 : 202,
        this.describe(job),
      );
      return true;
    }
    if (match[2] && req.method === "GET") {
      if (job.state !== "ready") {
        json(res, 409, { error: "video_not_ready" });
        return true;
      }
      if (this.serving >= 2) {
        json(res, 503, { error: "stream_busy" });
        return true;
      }
      job.serving = (job.serving || 0) + 1;
      this.serving++;
      const deadline = setTimeout(() => res.destroy(), 120000);
      deadline.unref();
      try {
        res.setTimeout(30000, () => res.destroy());
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": job.result.bytes,
          "Cache-Control": "no-store",
        });
        await pipeline(createReadStream(job.output), res);
      } finally {
        clearTimeout(deadline);
        job.serving--;
        this.serving--;
      }
      return true;
    }
    return false;
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.all([...this.jobs.keys()].map((id) => this.remove(id)));
  }
}
