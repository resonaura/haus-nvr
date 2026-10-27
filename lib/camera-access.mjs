import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { authenticator } from "./auth.mjs";
import { body, json } from "./http.mjs";
import { cameraId, privateIp } from "./camera-source.mjs";

export const cameraAccessKey = (key, id, camera, expiresAt) =>
  createHmac("sha256", key)
    .update(["camera-access-v1", id, camera, expiresAt].join("\n"))
    .digest("hex");

/** An HA-authorized camera capability cannot administer the node or change its source. */
export class CameraAccess {
  constructor(path, key, cameras, { now = Date.now } = {}) {
    Object.assign(this, { path, key, cameras, now });
    this.grants = new Map();
    this.auth = new Map();
    this.viewers = new Map();
    this.closed = new Map();
    this.tail = Promise.resolve();
  }
  async initialize() {
    try {
      const bytes = await readFile(this.path);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256").update(this.key).digest(),
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const values = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (!Array.isArray(values) || values.length > 256)
        throw Error("invalid_camera_access");
      for (const value of values)
        if (value.expiresAt > this.now()) this.grants.set(value.id, value);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw Error("camera_access_could_not_be_unlocked");
    }
    return this;
  }
  persist() {
    // Serialize snapshots so a slower older write cannot undo revocation.
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        const iv = randomBytes(12),
          cipher = createCipheriv(
            "aes-256-gcm",
            createHash("sha256").update(this.key).digest(),
            iv,
          );
        const bytes = Buffer.concat([
          cipher.update(JSON.stringify([...this.grants.values()])),
          cipher.final(),
        ]);
        await writeFile(
          this.path + ".next",
          Buffer.concat([iv, cipher.getAuthTag(), bytes]),
          { mode: 0o600 },
        );
        await rename(this.path + ".next", this.path);
      });
    return this.tail;
  }
  async provision(input) {
    if (
      !input ||
      !/^[a-f0-9]{32}$/.test(input.id) ||
      !cameraId(input.cameraId) ||
      !privateIp(input.advertiseHost) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.now() ||
      input.expiresAt > this.now() + 86400000 ||
      !Number.isInteger(input.preRollSeconds) ||
      input.preRollSeconds < 0 ||
      input.preRollSeconds > 30 ||
      typeof input.requireAudio !== "boolean" ||
      typeof input.recordAudio !== "boolean" ||
      typeof input.batteryPowered !== "boolean"
    )
      throw Error("invalid_camera_access");
    const source = await this.cameras.source(input.source);
    if (
      this.grants.has(input.id) &&
      this.grants.get(input.id).cameraId !== input.cameraId
    )
      throw Error("invalid_camera_access");
    for (const [id, grant] of this.grants)
      if (grant.expiresAt <= this.now()) {
        this.grants.delete(id);
        this.auth.delete(id);
      }
    if (!this.grants.has(input.id) && this.grants.size >= 256)
      throw Error("camera_access_busy");
    const value = {
      id: input.id,
      cameraId: input.cameraId,
      advertiseHost: input.advertiseHost,
      expiresAt: input.expiresAt,
      preRollSeconds: input.preRollSeconds,
      requireAudio: input.requireAudio,
      recordAudio: input.recordAudio,
      batteryPowered: input.batteryPowered,
      source: { kind: source.kind, url: source.url },
    };
    const previous = this.grants.get(value.id);
    this.grants.set(value.id, value);
    if (!previous || previous.expiresAt !== value.expiresAt)
      this.auth.delete(value.id);
    await this.persist();
    return {
      id: value.id,
      cameraId: value.cameraId,
      expiresAt: value.expiresAt,
    };
  }
  authenticate(req) {
    const id = req.headers["x-haus-camera-access"];
    const grant = this.grants.get(id);
    if (!grant || grant.expiresAt <= this.now()) return undefined;
    let check = this.auth.get(id);
    if (!check) {
      check = authenticator(
        cameraAccessKey(this.key, id, grant.cameraId, grant.expiresAt),
        this.now,
      );
      this.auth.set(id, check);
    }
    return check(req) ? grant : undefined;
  }
  async revoke(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error("invalid_camera_access");
    this.grants.delete(id);
    this.auth.delete(id);
    await this.persist();
    for (const session of this.cameras.sessions.values())
      for (const owner of [...session.owners.keys()])
        if (owner.startsWith(`camera-client-${id}-`))
          await this.cameras.release(session.id, owner);
    return { revoked: true };
  }
  async reconcile(input) {
    if (
      !Array.isArray(input?.cameras) ||
      input.cameras.length > 256 ||
      input.cameras.some((id) => !cameraId(id))
    )
      throw Error("invalid_camera_access_policy");
    const allowed = new Set(input.cameras);
    const denied = [...this.grants.values()].filter(
      (grant) => !allowed.has(grant.cameraId),
    );
    for (const grant of denied) await this.revoke(grant.id);
    return { revoked: denied.length };
  }
  async handle(req, res, path) {
    if (!/^\/v1\/client\/camera\/(status|warm|viewer|close)$/.test(path))
      return false;
    const grant = this.authenticate(req);
    if (!grant) {
      json(res, 401, { error: "camera_access_required" });
      return true;
    }
    if (path.endsWith("/status") && req.method === "GET") {
      const session = this.cameras.byCamera.get(grant.cameraId);
      json(res, 200, {
        cameraId: grant.cameraId,
        present: Boolean(session),
        ready: Boolean(session?.ring.ready()),
        ...this.cameras.status(),
      });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const input = await body(req, 72000);
    if (!/^[a-f0-9]{16}$/.test(input.clientSession))
      throw Error("invalid_camera_client");
    let owner = `camera-client-${grant.id}-${input.clientSession}-viewer`;
    if (path.endsWith("/warm") && input.preview === true)
      owner = `camera-client-${grant.id}-${input.clientSession}-preview`;
    for (const [key, viewer] of this.viewers)
      if (viewer.id && !this.cameras.engine.viewers.has(viewer.id))
        this.viewers.delete(key);
    for (const [key, expires] of this.closed)
      if (expires < this.now()) this.closed.delete(key);
    if (path.endsWith("/close")) {
      if (!/^[a-f0-9-]{36}$/.test(input.viewerId))
        throw Error("invalid_camera_viewer");
      const key = `${grant.id}:${input.clientSession}:${input.viewerId}`;
      if (this.closed.size >= 512)
        this.closed.delete(this.closed.keys().next().value);
      this.closed.set(key, this.now() + 60000);
      const viewer = this.viewers.get(key);
      this.viewers.delete(key);
      if (viewer) this.cameras.engine.closeViewer(viewer.id, owner);
      json(res, 200, { closed: true });
      return true;
    }
    if (path.endsWith("/warm")) {
      if (
        typeof input.active !== "boolean" ||
        (input.preview !== undefined && typeof input.preview !== "boolean")
      )
        throw Error("invalid_warm_session");
      if (!input.active) {
        const session = this.cameras.byCamera.get(grant.cameraId);
        if (session?.owners.has(owner))
          await this.cameras.release(session.id, owner);
        json(res, 200, { warm: false });
        return true;
      }
      if (input.preview && grant.batteryPowered)
        throw Error("camera_battery_preview_disabled");
    } else if (
      !/^[a-f0-9-]{36}$/.test(input.viewerId) ||
      typeof input.offer !== "string" ||
      !input.offer.startsWith("v=0") ||
      input.offer.length > 64000
    )
      throw Error("invalid_camera_viewer");
    const id = await this.cameras.acquire({ ...grant, owner });
    if (this.grants.get(grant.id)?.expiresAt !== grant.expiresAt) {
      await this.cameras.release(id.id, owner);
      throw Error("camera_access_revoked");
    }
    if (path.endsWith("/warm")) {
      json(res, 200, {
        warm: true,
        state: id.state,
        transport: "nvr-webrtc",
        expiresAt: id.expiresAt,
      });
      return true;
    }
    const key = `${grant.id}:${input.clientSession}:${input.viewerId}`;
    if (this.closed.has(key)) throw Error("camera_viewer_closed");
    if (this.viewers.has(key) || this.viewers.size >= 64)
      throw Error("camera_viewer_busy");
    const pending = { id: undefined };
    this.viewers.set(key, pending);
    try {
      const result = await this.cameras.offer(id.id, owner, input.offer);
      if (
        this.closed.has(key) ||
        this.grants.get(grant.id)?.expiresAt !== grant.expiresAt
      ) {
        this.cameras.engine.closeViewer(result.viewerId, owner);
        throw Error("camera_viewer_closed");
      }
      pending.id = result.viewerId;
      json(res, 200, {
        answer: result.answer,
        candidates: result.candidates ?? [],
      });
    } catch (error) {
      this.viewers.delete(key);
      throw error;
    }
    return true;
  }
}
