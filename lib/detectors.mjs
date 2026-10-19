import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { VisionWorker } from "../vision/worker.mjs";
import { body, json } from "./http.mjs";
export class Detectors {
  constructor(
    origin,
    capacity,
    {
      worker = (options) => new VisionWorker(options),
      now = () => Date.now(),
    } = {},
  ) {
    this.origin = origin;
    this.capacity = capacity;
    this.worker = worker;
    this.now = now;
    this.jobs = new Map();
    this.supported = false;
  }
  async initialize() {
    this.supported =
      !!this.origin &&
      (await access(new URL("../vision/model.onnx", import.meta.url))
        .then(() => true)
        .catch(() => false));
    this.timer = setInterval(() => void this.prune(), 5000);
    this.timer.unref();
  }
  status() {
    return {
      supported: this.supported,
      active: this.jobs.size + (this.retiring ?? 0),
      max: this.capacity.pressured ? 0 : this.capacity.detectors,
    };
  }
  start(source, mode = "objects") {
    const status = this.status();
    if (this.stopped || !status.supported || status.active >= status.max)
      throw new Error("detector_busy");
    const url = new URL(source);
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/cluster\/source\/[a-f0-9]{48}\/[A-Za-z0-9_-]+(?:\.(?:m3u8|ts|m4s|mp4|aac|key))?$/.test(
        url.pathname,
      ) ||
      !["objects", "motion"].includes(mode)
    )
      throw new Error("invalid_detector_source");
    const id = randomUUID(),
      job = { id, mode, until: this.now() + 45000, sequence: 0, events: [] };
    this.jobs.set(id, job);
    try {
      job.worker = this.worker({
        source: url.href,
        mode,
        onDetection: (event) => {
          if (this.jobs.get(id) !== job) return;
          job.events.push({ ...event, sequence: ++job.sequence });
          job.events = job.events.slice(-64);
        },
      });
    } catch (error) {
      this.jobs.delete(id);
      throw error;
    }
    return { id };
  }
  async remove(id) {
    const job = this.jobs.get(id);
    if (job) {
      this.jobs.delete(id);
      this.retiring = (this.retiring ?? 0) + 1;
      try {
        await job.worker.stop();
      } finally {
        this.retiring--;
      }
    }
  }
  async prune() {
    if (this.pruning) return;
    this.pruning = true;
    try {
      for (const job of this.jobs.values())
        if (
          job.until < this.now() ||
          job.worker.state === "failed" ||
          this.capacity.memoryUsed / this.capacity.memory > 0.9
        )
          await this.remove(job.id);
    } finally {
      this.pruning = false;
    }
  }
  async handle(req, res, path) {
    if (req.method === "POST" && path === "/v1/detectors") {
      const input = await body(req);
      json(res, 201, this.start(input.source, input.mode));
      return true;
    }
    const match = /^\/v1\/detectors\/([a-f0-9-]{36})$/.exec(path);
    if (!match) return false;
    if (req.method === "DELETE") {
      await this.remove(match[1]);
      json(res, 200, { stopped: true });
      return true;
    }
    if (req.method === "GET") {
      const job = this.jobs.get(match[1]);
      if (!job) {
        json(res, 404, { error: "detector_not_found" });
        return true;
      }
      job.until = this.now() + 45000;
      json(res, 200, {
        id: job.id,
        state: job.worker.state,
        events: job.events,
        lastFrameAt: job.worker.lastFrame,
        lastResultAt: job.worker.lastResult,
        processingMs: job.worker.processingMs,
      });
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
