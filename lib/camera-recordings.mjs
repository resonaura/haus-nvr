import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export function captureMetadata(value, cameraId, startAt, endAt) {
  if (value === undefined) return undefined; // Older controllers remain supported.
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    value.cameraId !== cameraId ||
    value.startAt !== startAt ||
    value.endAt !== endAt ||
    !Number.isSafeInteger(startAt) ||
    !Number.isSafeInteger(endAt) ||
    endAt <= startAt ||
    !Array.isArray(value.kinds) ||
    !value.kinds.length ||
    value.kinds.length > 10 ||
    value.kinds.some(
      (kind) =>
        !["manual", "motion", "person", "pet", "vehicle", "doorbell"].includes(
          kind,
        ),
    )
  )
    throw Error("invalid_camera_recording");
  return {
    id: value.id,
    cameraId,
    startAt,
    endAt,
    kinds: [...new Set(value.kinds)],
  };
}

/** A durable outbox bridges capture completion, archive admission and controller recovery. */
export class CameraRecordings {
  constructor(root, recordings, blobs, { now = Date.now } = {}) {
    Object.assign(this, { root, recordings, blobs, now });
    this.db = recordings.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS camera_recording_outbox(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0)`);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS camera_activity_events(id TEXT PRIMARY KEY,value TEXT NOT NULL,state TEXT NOT NULL,error TEXT,acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS camera_activity_requests(camera_id TEXT NOT NULL,policy_id TEXT NOT NULL,request_id TEXT NOT NULL,event_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(camera_id,policy_id,request_id));
      CREATE INDEX IF NOT EXISTS camera_activity_request_time ON camera_activity_requests(created_at)`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS camera_activity_event_state ON camera_activity_events(state,acknowledged)",
    );
    this.releases = new Map();
    this.tail = Promise.resolve();
  }
  async initialize() {
    this.db.exec(
      "UPDATE camera_activity_events SET state='interrupted',error='node_restarted' WHERE state='recording' AND id NOT IN(SELECT id FROM camera_recording_outbox)",
    );
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // A crash between hard-linking a finished clip and committing its receipt
    // leaves an unreferenced file. Never infer metadata from its filename.
    for (const name of await readdir(this.root))
      if (/^[a-f0-9-]{36}\.mp4$/.test(name)) {
        const row = this.db
          .prepare("SELECT archived FROM camera_recording_outbox WHERE id=?")
          .get(name.slice(0, -4));
        if (!row || row.archived)
          await rm(join(this.root, name), { force: true });
      }
    this.timer = setInterval(() => void this.tick().catch(() => {}), 5000);
    this.timer.unref();
    void this.tick().catch(() => {});
    return this;
  }
  preserve(job) {
    const task = this.tail.catch(() => {}).then(() => this.preserveOne(job));
    this.tail = task;
    return task;
  }
  beginActivity(event, requestId) {
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM camera_activity_events WHERE state='interrupted' AND acknowledged=0",
        )
        .get().n >= 1024
    )
      throw Error("camera_activity_journal_full");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO camera_activity_events(id,value,state)VALUES(?,?,'recording') ON CONFLICT(id)DO UPDATE SET value=excluded.value WHERE state='recording'",
        )
        .run(event.id, JSON.stringify(event));
      if (requestId)
        this.rememberActivityRequest(
          event.cameraId,
          event.origin.policyId,
          requestId,
          event.id,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  activityRequest(cameraId, policyId, requestId) {
    return this.db
      .prepare(
        "SELECT event_id FROM camera_activity_requests WHERE camera_id=? AND policy_id=? AND request_id=?",
      )
      .get(cameraId, policyId, requestId)?.event_id;
  }
  rememberActivityRequest(cameraId, policyId, requestId, eventId) {
    this.db
      .prepare("DELETE FROM camera_activity_requests WHERE created_at<?")
      .run(this.now() - 86400000);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO camera_activity_requests(camera_id,policy_id,request_id,event_id,created_at)VALUES(?,?,?,?,?)",
      )
      .run(cameraId, policyId, requestId, eventId, this.now());
  }
  interruptActivity(id, reason) {
    this.db
      .prepare(
        "UPDATE camera_activity_events SET state='interrupted',error=? WHERE id=? AND state='recording'",
      )
      .run(
        [
          "storage_full",
          "camera_recording_incomplete",
          "node_stopped",
        ].includes(reason)
          ? reason
          : "capture_interrupted",
        id,
      );
  }
  interruptedActivities(cursor = "0") {
    if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      throw Error("invalid_cursor");
    const rows = this.db
      .prepare(
        "SELECT rowid AS sequence,value,error FROM camera_activity_events WHERE state='interrupted' AND acknowledged=0 AND rowid>? AND id NOT IN(SELECT id FROM camera_recording_outbox) ORDER BY rowid LIMIT 17",
      )
      .all(Number(cursor));
    return {
      items: rows.slice(0, 16).map((row) => ({
        event: JSON.parse(row.value),
        state: "interrupted",
        error: row.error,
      })),
      nextCursor: rows.length > 16 ? String(rows[15].sequence) : null,
    };
  }
  acknowledgeInterrupted(id) {
    this.db
      .prepare(
        "UPDATE camera_activity_events SET acknowledged=1 WHERE id=? AND state='interrupted'",
      )
      .run(id);
    return { acknowledged: true };
  }
  async preserveOne(job) {
    if (!job.metadata) return;
    const old = this.db
      .prepare("SELECT value FROM camera_recording_outbox WHERE id=?")
      .get(job.id);
    if (old) {
      if (JSON.parse(old.value).sha256 !== job.result.sha256)
        throw Error("camera_recording_conflict");
      return;
    }
    const pending = this.db
      .prepare("SELECT value FROM camera_recording_outbox WHERE archived=0")
      .all();
    if (
      pending.length >= 128 ||
      pending.reduce((sum, row) => sum + JSON.parse(row.value).bytes, 0) +
        job.result.bytes >
        2 * 1024 ** 3
    )
      throw Error("camera_recording_outbox_full");
    const file = join(this.root, `${job.id}.mp4`);
    const release = await this.blobs.reserveWorkspace(job.result.bytes);
    try {
      await link(job.output, file);
      const handle = await open(file, "r");
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const value = {
        ...job.result,
        event: {
          ...job.metadata,
          duration: job.result.duration,
          mediaStartAt: job.result.mediaStartAt,
          playbackVersion: 0,
          playbackInfo: { audio: job.result.audio, sourceAudioMissing: false },
        },
      };
      this.db
        .prepare("INSERT INTO camera_recording_outbox(id,value)VALUES(?,?)")
        .run(job.id, JSON.stringify(value));
      this.db
        .prepare(
          "UPDATE camera_activity_events SET state='completed' WHERE id=?",
        )
        .run(job.id);
      this.releases.set(job.id, release);
    } catch (error) {
      release();
      await rm(file, { force: true });
      throw error;
    }
  }
  async tick() {
    if (this.running || this.stopped) return this.running;
    this.running = this.archive().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async archive() {
    for (const row of this.db
      .prepare(
        "SELECT * FROM camera_recording_outbox WHERE archived=0 ORDER BY sequence LIMIT 4",
      )
      .all()) {
      if (this.stopped) break;
      const value = JSON.parse(row.value),
        file = join(this.root, `${row.id}.mp4`);
      try {
        const info = await stat(file);
        if (info.size !== value.bytes)
          throw Error("camera_recording_incomplete");
        // Account for retained workspace copies when retrying after a restart.
        // Archive writes retain their normal quota.
        if (!this.releases.has(row.id))
          this.releases.set(
            row.id,
            await this.blobs.reserveWorkspace(info.size),
          );
        const stream = createReadStream(file);
        try {
          const saved = await this.blobs.put(value.sha256, stream, value.bytes);
          if (saved.existing) {
            const verified = await this.blobs.verify(value.sha256);
            if (!verified.verified || verified.bytes !== value.bytes)
              throw Error("camera_recording_incomplete");
          }
        } finally {
          stream.destroy();
        }
        const existing = this.recordings.get(row.id);
        if (
          !existing ||
          (existing.digest === value.sha256 &&
            existing.storageVariant !== "prepared")
        )
          await this.recordings.add({
            event: value.event,
            digest: value.sha256,
            variant: "original",
          });
        else if (
          existing.originalDigest !== value.sha256 &&
          existing.digest !== value.sha256
        )
          throw Error("camera_recording_conflict");
        this.db
          .prepare("UPDATE camera_recording_outbox SET archived=1 WHERE id=?")
          .run(row.id);
        await rm(file, { force: true });
        this.releases.get(row.id)?.();
        this.releases.delete(row.id);
      } catch {
        // A full archive does not erase the finished clip or block Live/rings.
      }
    }
  }
  get(id) {
    const row = this.db
      .prepare(
        "SELECT value,archived,acknowledged FROM camera_recording_outbox WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    return {
      ...JSON.parse(row.value),
      state: row.archived ? "ready" : "archiving",
      acknowledged: Boolean(row.acknowledged),
    };
  }
  list(cursor = "0") {
    if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      throw Error("invalid_cursor");
    const rows = this.db
      .prepare(
        "SELECT id,sequence FROM camera_recording_outbox WHERE archived=1 AND acknowledged=0 AND sequence>? ORDER BY sequence LIMIT 17",
      )
      .all(Number(cursor));
    return {
      items: rows.slice(0, 16).map(({ id }) => this.get(id)),
      nextCursor: rows.length > 16 ? String(rows[15].sequence) : null,
    };
  }
  acknowledge(id, digest) {
    const value = this.get(id);
    if (!value || value.state !== "ready" || value.sha256 !== digest)
      throw Error("camera_recording_not_found");
    this.db
      .prepare("UPDATE camera_recording_outbox SET acknowledged=1 WHERE id=?")
      .run(id);
    return { acknowledged: true };
  }
  pending(digest) {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM camera_recording_outbox WHERE acknowledged=0 AND json_extract(value,'$.sha256')=?",
        )
        .get(digest) !== undefined
    );
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tail.catch(() => {});
    await this.running;
    for (const release of this.releases.values()) release();
    this.releases.clear();
  }
}
