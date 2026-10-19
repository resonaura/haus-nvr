import { DatabaseSync } from "node:sqlite";
export class RecordingIndex {
  constructor(path, blobs) {
    this.blobs = blobs;
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,digest TEXT NOT NULL,start_at INTEGER NOT NULL,value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS recordings_time ON recordings(start_at DESC,id DESC); CREATE INDEX IF NOT EXISTS recordings_digest ON recordings(digest)",
    );
  }
  async add(input) {
    const { event, digest } = input ?? {};
    if (
      !event ||
      !/^[a-f0-9-]{36}$/.test(event.id) ||
      !/^camera\.[a-z0-9_]+$/.test(event.cameraId) ||
      !Number.isSafeInteger(event.startAt) ||
      !Number.isSafeInteger(event.endAt) ||
      (event.mediaStartAt !== undefined &&
        (!Number.isFinite(event.mediaStartAt) ||
          event.mediaStartAt < 0 ||
          event.mediaStartAt > event.endAt + 30000)) ||
      event.endAt < event.startAt ||
      !Number.isFinite(event.duration) ||
      event.duration < 0 ||
      !Array.isArray(event.kinds) ||
      event.kinds.some(
        (kind) => typeof kind !== "string" || kind.length > 50,
      ) ||
      event.kinds.length > 10 ||
      Buffer.byteLength(JSON.stringify(event)) > 4096
    )
      throw new Error("invalid_recording_metadata");
    await this.blobs.info(digest);
    const value = {
      id: event.id,
      cameraId: event.cameraId,
      startAt: event.startAt,
      ...(event.mediaStartAt !== undefined
        ? { mediaStartAt: Math.round(event.mediaStartAt) }
        : {}),
      endAt: event.endAt,
      duration: event.duration,
      kinds: event.kinds,
      playbackVersion: event.playbackVersion,
      ...(event.playbackInfo
        ? {
            playbackInfo: {
              ...(typeof event.playbackInfo.audio === "boolean"
                ? { audio: event.playbackInfo.audio }
                : {}),
              ...(typeof event.playbackInfo.sourceAudioMissing === "boolean"
                ? { sourceAudioMissing: event.playbackInfo.sourceAudioMissing }
                : {}),
              ...(Number.isFinite(event.playbackInfo.largestGap)
                ? { largestGap: Math.max(0, event.playbackInfo.largestGap) }
                : {}),
            },
          }
        : {}),
      digest,
    };
    this.db
      .prepare(
        "INSERT INTO recordings(id,digest,start_at,value)VALUES(?,?,?,?) ON CONFLICT(id)DO UPDATE SET digest=excluded.digest,start_at=excluded.start_at,value=excluded.value",
      )
      .run(value.id, digest, value.startAt, JSON.stringify(value));
  }
  get(id) {
    const row = this.db
      .prepare("SELECT value FROM recordings WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.value) : null;
  }
  list(cursor) {
    let where = "",
      args = [];
    if (cursor) {
      let value;
      try {
        value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        throw new Error("invalid_cursor");
      }
      if (
        !Array.isArray(value) ||
        !Number.isSafeInteger(value[0]) ||
        typeof value[1] !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value[1])
      )
        throw new Error("invalid_cursor");
      where = "WHERE start_at<? OR (start_at=? AND id<?)";
      args = [value[0], value[0], value[1]];
    }
    const rows = this.db
      .prepare(
        `SELECT value FROM recordings ${where} ORDER BY start_at DESC,id DESC LIMIT 201`,
      )
      .all(...args);
    const items = rows.slice(0, 200).map((row) => JSON.parse(row.value)),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > 200 && last
          ? Buffer.from(JSON.stringify([last.startAt, last.id])).toString(
              "base64url",
            )
          : null,
    };
  }
  remove(digest) {
    this.db.prepare("DELETE FROM recordings WHERE digest=?").run(digest);
  }
  close() {
    this.db.close();
  }
}
