import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { json, body } from "./http.mjs";
/** Optional live relays pull a narrow helper capability, never a Home Assistant access token. */
export class WorkerStreams {
  constructor(root, origin, { max = 4, spawnProcess = spawn } = {}) {
    this.root = root;
    this.origin = origin;
    this.max = max;
    this.capacity = () => max;
    this.spawnProcess = spawnProcess;
    this.jobs = new Map();
    this.stopped = false;
    this.timer = setInterval(() => void this.prune(), 5000);
    this.timer.unref();
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root))
      if (/^[a-f0-9-]{36}$/.test(name))
        await rm(join(this.root, name), { recursive: true, force: true });
  }
  get size() {
    return this.jobs.size;
  }
  async start(source) {
    if (!this.origin || this.stopped || this.jobs.size >= this.capacity())
      throw new Error("stream_busy");
    const url = new URL(source);
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/cluster\/source\/[a-f0-9]{48}\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      throw new Error("invalid_stream_source");
    const id = randomUUID(),
      dir = join(this.root, id),
      job = { id, dir, lastRead: Date.now(), state: "starting" };
    this.jobs.set(id, job);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (this.stopped || this.jobs.get(id) !== job)
        throw new Error("stream_stopped");
      const child = this.spawnProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-rw_timeout",
          "15000000",
          "-live_start_index",
          "-1",
          "-protocol_whitelist",
          "http,https,tcp,tls,crypto",
          "-i",
          url.href,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-threads",
          "2",
          "-f",
          "hls",
          "-hls_time",
          "2",
          "-hls_list_size",
          "6",
          "-hls_delete_threshold",
          "2",
          "-hls_flags",
          "delete_segments+independent_segments",
          "-hls_segment_filename",
          join(dir, "segment-%09d.ts"),
          join(dir, "index.m3u8"),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      job.child = child;
      child.stderr.on("data", () => {});
      child.on("error", () => {
        job.state = "failed";
      });
      child.on("exit", () => {
        job.state = "stopped";
      });
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        if (
          job.state === "failed" ||
          job.state === "stopped" ||
          this.stopped ||
          this.jobs.get(id) !== job
        )
          throw new Error("stream_unavailable");
        if (await stat(join(dir, "index.m3u8")).catch(() => null)) {
          job.state = "ready";
          return { id };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("stream_timeout");
    } catch (error) {
      await this.remove(id);
      throw error;
    }
  }
  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    if (job.child && job.child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          job.child.kill("SIGKILL");
        }, 1500);
        timer.unref();
        job.child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        job.child.kill("SIGTERM");
      });
    }
    await rm(job.dir, { recursive: true, force: true });
  }
  async prune() {
    if (this.pruning) return;
    this.pruning = true;
    try {
      for (const job of this.jobs.values()) {
        let bytes = 0;
        for (const file of await readdir(job.dir).catch(() => []))
          bytes +=
            (await stat(join(job.dir, file)).catch(() => null))?.size ?? 0;
        if (
          Date.now() - job.lastRead > 90000 ||
          bytes > 64 * 1024 ** 2 ||
          ["stopped", "failed"].includes(job.state)
        )
          await this.remove(job.id);
      }
    } finally {
      this.pruning = false;
    }
  }
  async handle(req, res, path) {
    if (path === "/v1/streams" && req.method === "POST") {
      const input = await body(req);
      json(res, 201, await this.start(input.source));
      return true;
    }
    const match =
      /^\/v1\/streams\/([a-f0-9-]{36})(?:\/(index\.m3u8|segment-\d+\.ts))?$/.exec(
        path,
      );
    if (!match) return false;
    if (req.method === "DELETE" && !match[2]) {
      await this.remove(match[1]);
      json(res, 200, { stopped: true });
      return true;
    }
    const job = this.jobs.get(match[1]);
    if (!job) {
      json(res, 404, { error: "stream_not_found" });
      return true;
    }
    if (req.method === "GET" && match[2]) {
      job.lastRead = Date.now();
      const file = join(job.dir, match[2]);
      let info;
      try {
        info = await stat(file);
      } catch {
        json(res, 404, { error: "segment_not_found" });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": match[2].endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t",
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      await pipeline(createReadStream(file), res).catch(() => {});
      return true;
    }
    return false;
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled(
      [...this.jobs.keys()].map((id) => this.remove(id)),
    );
  }
}
