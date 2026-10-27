import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { cameraId, privateIp } from "./camera-source.mjs";

const owner = (id) =>
  `continuity-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

/** A bounded controller assignment keeps one admitted producer/ring alive without controller heartbeats. */
export class CameraContinuity {
  constructor(path, key, cameras, { now = Date.now } = {}) {
    Object.assign(this, { path, key, cameras, now });
    this.plans = new Map();
    this.retry = new Map();
    this.tail = Promise.resolve();
  }
  async initialize() {
    try {
      const bytes = await readFile(this.path);
      if (bytes.length > 400000) throw Error("invalid_camera_continuity");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256").update(this.key).digest(),
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      const values = JSON.parse(
        Buffer.concat([
          cipher.update(bytes.subarray(28)),
          cipher.final(),
        ]).toString(),
      );
      this.plans = await this.validate(values, true);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw Error("camera_continuity_could_not_be_unlocked");
    }
    this.timer = setInterval(() => void this.tick().catch(() => {}), 10000);
    this.timer.unref();
    void this.tick().catch(() => {});
    return this;
  }
  async validate(values, restoring = false) {
    if (!Array.isArray(values) || values.length > 64)
      throw Error("invalid_camera_continuity");
    const result = new Map();
    for (const value of values) {
      if (restoring && value?.expiresAt <= this.now()) continue;
      if (
        !cameraId(value?.cameraId) ||
        !privateIp(value.advertiseHost) ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= this.now() ||
        value.expiresAt > this.now() + 86400000 ||
        !Number.isInteger(value.preRollSeconds) ||
        value.preRollSeconds < 0 ||
        value.preRollSeconds > 30 ||
        typeof value.requireAudio !== "boolean" ||
        typeof value.recordAudio !== "boolean" ||
        result.has(value.cameraId)
      )
        throw Error("invalid_camera_continuity");
      const source = await this.cameras.source(value.source);
      result.set(value.cameraId, {
        cameraId: value.cameraId,
        source: { kind: source.kind, url: source.url },
        advertiseHost: value.advertiseHost,
        expiresAt: value.expiresAt,
        preRollSeconds: value.preRollSeconds,
        requireAudio: value.requireAudio,
        recordAudio: value.recordAudio,
      });
    }
    return result;
  }
  async persist(plans) {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        createHash("sha256").update(this.key).digest(),
        iv,
      );
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify([...plans.values()])),
      cipher.final(),
    ]);
    await writeFile(
      this.path + ".next",
      Buffer.concat([iv, cipher.getAuthTag(), bytes]),
      { mode: 0o600 },
    );
    await rename(this.path + ".next", this.path);
  }
  update(values) {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.stopped) throw Error("camera_continuity_stopped");
        const next = await this.validate(values);
        await this.persist(next);
        const previous = this.plans;
        this.plans = next;
        for (const [id, plan] of next)
          if (
            JSON.stringify({ ...previous.get(id), expiresAt: 0 }) !==
            JSON.stringify({ ...plan, expiresAt: 0 })
          )
            this.retry.delete(id);
        for (const [id] of previous)
          if (!next.has(id)) {
            this.retry.delete(id);
            await this.release(id);
          }
        await this.tick();
        return this.status();
      });
    this.tail = task;
    return task;
  }
  async release(id) {
    for (const session of [...this.cameras.sessions.values()])
      if (session.cameraId === id && session.owners.has(owner(id)))
        await this.cameras.release(session.id, owner(id)).catch(() => {});
  }
  status() {
    return {
      profile: 1,
      cameras: [...this.plans.values()]
        .filter((plan) => plan.expiresAt > this.now())
        .map((plan) => ({
          cameraId: plan.cameraId,
          expiresAt: plan.expiresAt,
          state: this.cameras.byCamera.get(plan.cameraId)?.ring.ready()
            ? "ready"
            : "waiting",
        })),
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const [id, plan] of this.plans) {
        if (plan.expiresAt <= this.now()) {
          await this.release(id);
          continue;
        }
        if ((this.retry.get(id)?.until ?? 0) > this.now()) continue;
        try {
          const session = await this.cameras.acquire({
            ...plan,
            owner: owner(id),
          });
          const current = this.plans.get(id);
          if (
            this.stopped ||
            !current ||
            current.expiresAt <= this.now() ||
            JSON.stringify({ ...current, expiresAt: 0 }) !==
              JSON.stringify({ ...plan, expiresAt: 0 })
          )
            await this.cameras.release(session.id, owner(id)).catch(() => {});
          else this.retry.delete(id);
        } catch {
          const attempts = Math.min(5, (this.retry.get(id)?.attempts ?? 0) + 1);
          this.retry.set(id, {
            attempts,
            until: this.now() + Math.min(30000, 1000 * 2 ** attempts),
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tail.catch(() => {});
  }
}
