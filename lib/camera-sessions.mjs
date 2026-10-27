import { mkdir, rm, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  cameraSource,
  cameraId,
  ownerId,
  privateIp,
} from "./camera-source.mjs";
import { CameraRing } from "./camera-ring.mjs";
import { json, body } from "./http.mjs";
import { parseRange } from "./blobs.mjs";

/** Signed controller leases own producers. Browsers never receive RTSP credentials. */
export class CameraSessions {
  constructor(
    root,
    engine,
    {
      capacity,
      blobs,
      max = 4,
      now = Date.now,
      source = cameraSource,
      ring = (path, input, options) => new CameraRing(path, input, options),
    } = {},
  ) {
    Object.assign(this, {
      root,
      engine,
      capacity,
      blobs,
      max,
      now,
      source,
      ring,
    });
    this.sessions = new Map();
    this.byCamera = new Map();
    this.pending = new Map();
    this.closed = false;
    this.serving = 0;
    this.otherStreams = () => 0;
    this.finalizerBusy = false;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root))
      if (/^[a-f0-9-]{36}$/.test(name))
        await rm(join(this.root, name), { recursive: true, force: true });
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
    return this;
  }
  status() {
    return {
      profile: 1,
      active: this.sessions.size,
      max:
        this.closed || this.capacity?.pressured
          ? 0
          : Math.max(0, this.max - this.otherStreams()),
      webrtc: true,
      recording: true,
    };
  }
  describe(session) {
    return {
      id: session.id,
      state: session.ring.ready() ? "ready" : "warming",
      expiresAt: Math.max(0, ...session.owners.values()),
      capabilities: { webrtc: true, recording: true },
      audio: session.ring.metadata?.audio === true,
      preRollSeconds: session.preRollSeconds,
      requireAudio: session.requireAudio,
      recordAudio: session.recordAudio,
    };
  }
  async acquire(input) {
    if (
      !input ||
      !cameraId(input.cameraId) ||
      !ownerId(input.owner) ||
      !privateIp(input.advertiseHost) ||
      (input.recordAudio !== undefined &&
        typeof input.recordAudio !== "boolean") ||
      (input.requireAudio !== undefined &&
        typeof input.requireAudio !== "boolean") ||
      (input.preRollSeconds !== undefined &&
        (!Number.isInteger(input.preRollSeconds) ||
          input.preRollSeconds < 0 ||
          input.preRollSeconds > 30))
    )
      throw new Error("invalid_camera_session");
    const selected = await this.source(input.source);
    const prior = this.pending.get(input.cameraId);
    if (prior) {
      await prior.catch(() => {});
      return this.acquire(input);
    }
    const task = this.open(input, selected);
    this.pending.set(input.cameraId, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(input.cameraId) === task)
        this.pending.delete(input.cameraId);
    }
  }
  async open(input, selected) {
    if (this.closed) throw new Error("camera_sessions_stopped");
    let existing = this.byCamera.get(input.cameraId);
    if (existing?.ring.failed || this.engine.failed) {
      for (const session of [...this.sessions.values()])
        if (session === existing || this.engine.failed)
          await this.remove(session);
      existing = undefined;
    }
    if (
      existing &&
      existing.source.url === selected.url &&
      existing.source.kind === selected.kind &&
      existing.requireAudio === (input.requireAudio ?? true) &&
      existing.recordAudio === (input.recordAudio ?? true)
    ) {
      if (!existing.owners.has(input.owner) && existing.owners.size >= 32)
        throw new Error("camera_owner_busy");
      existing.owners.set(input.owner, this.now() + 60000);
      return this.describe(existing);
    }
    // A credential/source rotation gets a new private name. Existing owners keep
    // their last producer until their own leases expire or the replacement is ready.
    const rotation = Boolean(existing);
    if (
      this.capacity?.pressured ||
      this.sessions.size + this.otherStreams() >=
        this.max + (rotation ? 1 : 0) ||
      (rotation &&
        [...this.sessions.values()].some((session) => session.rotation))
    )
      throw new Error("camera_session_busy");
    const id = randomUUID();
    const session = {
      id,
      cameraId: input.cameraId,
      source: selected,
      preRollSeconds: input.preRollSeconds ?? 8,
      requireAudio: input.requireAudio ?? true,
      recordAudio: input.recordAudio ?? true,
      rotation,
      owners: new Map([[input.owner, this.now() + 60000]]),
    };
    this.sessions.set(id, session);
    try {
      await this.engine.initialize(input.advertiseHost);
      await this.engine.add(id, selected.url, {
        sourceKind: selected.kind,
        cameraId: input.cameraId,
      });
      session.ring = this.ring(join(this.root, id), this.engine.localRtsp(id), {
        now: this.now,
        log: (event, fields) =>
          this.engine.log?.(event, { cameraId: session.cameraId, ...fields }),
        requireAudio: session.requireAudio,
        recordAudio: session.recordAudio,
        retentionSeconds: session.preRollSeconds + 40,
        acquireFinalizer: () => {
          if (this.finalizerBusy) return undefined;
          this.finalizerBusy = true;
          return () => {
            this.finalizerBusy = false;
          };
        },
        reserve: (bytes) =>
          (this.blobs?.reserveWorkspace
            ? this.blobs.reserveWorkspace(bytes)
            : this.blobs?.reserveTransient(bytes)) ?? Promise.resolve(() => {}),
      });
      await session.ring.start();
      if (this.closed) throw new Error("camera_sessions_stopped");
      this.byCamera.set(input.cameraId, session);
      if (existing) existing.replacement = session;
      return this.describe(session);
    } catch {
      await session.ring?.stop().catch(() => {});
      await this.engine.remove(id);
      this.sessions.delete(id);
      throw new Error("camera_session_unavailable");
    }
  }
  owned(id, owner) {
    const session = this.sessions.get(id);
    if (
      !session ||
      !ownerId(owner) ||
      (session.owners.get(owner) ?? 0) <= this.now()
    )
      throw new Error("camera_session_not_found");
    return session;
  }
  renew(id, owner) {
    const session = this.owned(id, owner);
    const replacement = session.replacement;
    if (
      replacement &&
      this.sessions.get(replacement.id) === replacement &&
      replacement.ring.ready()
    ) {
      replacement.owners.set(owner, this.now() + 60000);
      if (this.recording(session))
        session.owners.set(owner, this.now() + 60000);
      return this.describe(replacement);
    }
    session.owners.set(owner, this.now() + 60000);
    return this.describe(session);
  }
  async offer(id, owner, offer) {
    const session = this.owned(id, owner);
    if (!session.ring.ready()) {
      const deadline = this.now() + 10000;
      while (
        !session.ring.ready() &&
        !session.ring.failed &&
        this.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 200));
      if (!session.ring.ready()) throw new Error("camera_stream_warming");
    }
    return this.engine.offer(session.id, owner, offer);
  }
  async release(id, owner) {
    const session = this.sessions.get(id);
    if (!session || !ownerId(owner) || !session.owners.has(owner))
      throw new Error("camera_session_not_found");
    session.owners.delete(owner);
    for (const [viewerId, viewer] of this.engine.viewers)
      if (viewer.session === id && viewer.owner === owner)
        this.engine.closeViewer(viewerId, owner);
    if (!session.owners.size && !this.recording(session))
      await this.remove(session);
  }
  recording(session) {
    return [...(session.ring?.jobs.values() ?? [])].some(
      (job) =>
        ["recording", "preparing"].includes(job.state) ||
        (job.state === "ready" &&
          this.now() - (job.completedAt ?? this.now()) < 60000),
    );
  }
  async remove(session) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    if (this.byCamera.get(session.cameraId) === session)
      this.byCamera.delete(session.cameraId);
    if (session.replacement) session.replacement.rotation = false;
    await session.ring?.stop();
    await this.engine.remove(session.id);
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const session of this.sessions.values()) {
        if (!session.ring) continue;
        for (const [owner, until] of session.owners)
          if (until <= this.now()) {
            session.owners.delete(owner);
            for (const [viewerId, viewer] of this.engine.viewers)
              if (viewer.session === session.id && viewer.owner === owner)
                this.engine.closeViewer(viewerId, owner);
          }
        if (
          session.ring.failed ||
          this.engine.failed ||
          (!session.owners.size && !this.recording(session)) ||
          this.now() - (session.ring.freshAt ?? session.ring.startedAt) > 30000
        ) {
          await this.remove(session);
          continue;
        }
        await session.ring.sample();
      }
    } finally {
      this.ticking = false;
    }
  }
  async handle(req, res, path) {
    if (path === "/v1/cameras/sessions" && req.method === "POST") {
      json(res, 201, await this.acquire(await body(req, 8192)));
      return true;
    }
    const match =
      /^\/v1\/cameras\/sessions\/([a-f0-9-]{36})(?:\/(lease|webrtc|viewers\/([a-f0-9-]{36})|recordings(?:\/([a-f0-9-]{36})(?:\/(status|media))?)?))?$/.exec(
        path,
      );
    if (!match) return false;
    if (!["POST", "DELETE"].includes(req.method)) {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const input = await body(req, 72000);
    const recordJob =
      match[4] && this.sessions.get(match[1])?.ring.jobs.get(match[4]);
    const session =
      recordJob && recordJob.owner === input.owner
        ? this.sessions.get(match[1])
        : this.owned(match[1], input.owner);
    if (!match[2] && req.method === "DELETE") {
      await this.release(session.id, input.owner);
      json(res, 200, { released: true });
      return true;
    }
    if (match[2] === "lease" && req.method === "POST") {
      json(res, 200, this.renew(session.id, input.owner));
      return true;
    }
    if (match[2] === "webrtc" && req.method === "POST") {
      json(res, 200, await this.offer(session.id, input.owner, input.offer));
      return true;
    }
    if (match[3] && req.method === "DELETE") {
      if (this.engine.viewers.get(match[3])?.session !== session.id)
        throw new Error("camera_session_not_found");
      this.engine.closeViewer(match[3], input.owner);
      json(res, 200, { closed: true });
      return true;
    }
    if (match[2] === "recordings" && req.method === "POST") {
      const prior = session.ring.jobs.get(input.eventId);
      if (prior && prior.owner !== input.owner)
        throw new Error("camera_recording_not_found");
      const result = await session.ring.record({
        ...input,
        startAt: input.startAt - session.preRollSeconds * 1000,
      });
      session.ring.jobs.get(input.eventId).owner = input.owner;
      json(res, 202, result);
      return true;
    }
    if (match[4]) {
      const job = session.ring.jobs.get(match[4]);
      if (!job || job.owner !== input.owner)
        throw new Error("camera_recording_not_found");
      if (!match[5] && req.method === "DELETE") {
        await session.ring.removeRecording(job.id);
        json(res, 200, { removed: true });
        return true;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      session.owners.set(input.owner, this.now() + 60000);
      if (match[5] === "status") {
        json(res, 200, session.ring.describe(job));
        return true;
      }
      if (match[5] === "media") {
        if (job.state !== "ready") {
          json(res, 409, { error: "camera_recording_not_ready" });
          return true;
        }
        if (this.serving >= 4) throw new Error("camera_viewer_busy");
        const range = parseRange(req.headers.range, job.result.bytes);
        this.serving++;
        res.setTimeout(30000, () => res.destroy());
        res.writeHead(range.partial ? 206 : 200, {
          "Content-Type": "video/mp4",
          "Content-Length": range.end - range.start + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          ...(range.partial
            ? {
                "Content-Range": `bytes ${range.start}-${range.end}/${job.result.bytes}`,
              }
            : {}),
        });
        try {
          await pipeline(
            createReadStream(job.output, {
              start: range.start,
              end: range.end,
            }),
            res,
          ).catch(() => {});
        } finally {
          this.serving--;
        }
        return true;
      }
    }
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.close();
    return this.stopping;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.remove(session)),
    );
    await this.engine.stop();
  }
}
