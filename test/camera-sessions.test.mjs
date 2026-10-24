import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cameraSource } from "../lib/camera-source.mjs";
import { CameraSessions } from "../lib/camera-sessions.mjs";
import { CameraRing, cameraProcess } from "../lib/camera-ring.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

const owner = "fixture-owner-123456789",
  other = "second-owner-123456789";
const input = (extra = {}) => ({
  cameraId: "camera.fixture",
  owner,
  advertiseHost: "192.168.1.5",
  source: {
    kind: "p2p-restream",
    url: "rtsp://name:private-password@192.168.1.9:8555/stream",
  },
  ...extra,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-camera-sessions-"));
  let at = 100000;
  const added = [],
    removed = [],
    rings = [];
  const engine = {
    viewers: new Map(),
    initialize: async () => {},
    add: async (...args) => added.push(args),
    remove: async (id) => removed.push(id),
    localRtsp: (id) => `rtsp://127.0.0.1:8554/${id}_raw`,
    stop: async () => {},
    closeViewer(id, requestedOwner) {
      if (this.viewers.get(id)?.owner === requestedOwner)
        this.viewers.delete(id);
    },
    offer: async () => ({
      viewerId: randomUUID(),
      answer: { type: "answer", sdp: "v=0\r\n" },
      candidates: [],
    }),
  };
  const sessions = await new CameraSessions(root, engine, {
    max: 2,
    now: () => at,
    ring: () => {
      const ring = {
        jobs: new Map(),
        ready: () => true,
        start: async () => {},
        stop: async () => {},
        sample: async () => {},
        describe: (job) => job,
        record: async (value) => {
          const job = { ...value, id: value.eventId, state: "recording" };
          ring.jobs.set(job.id, job);
          return job;
        },
      };
      rings.push(ring);
      return ring;
    },
  }).initialize();
  t.after(async () => {
    await sessions.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    sessions,
    engine,
    added,
    removed,
    rings,
    advance: (ms) => (at += ms),
  };
}
test("RTSP source validation pins private DNS and rejects media-engine directives/public rebinding", async () => {
  const result = await cameraSource(
    { kind: "p2p-restream", url: "rtsp://user:pass@camera.home:8555/live" },
    async () => [{ address: "192.168.1.9" }],
  );
  assert.equal(result.url, "rtsp://user:pass@192.168.1.9:8555/live");
  for (const url of [
    "http://192.168.1.1/live",
    "rtsp://8.8.8.8/live",
    "rtsp://192.168.1.1/live#transport=exec:bad",
    "ffmpeg:rtsp://192.168.1.1/live",
  ])
    await assert.rejects(
      cameraSource({ kind: "rtsp", url }),
      /invalid_camera_source/,
    );
  await assert.rejects(
    cameraSource({ kind: "rtsp", url: "rtsp://camera.home/live" }, async () => [
      { address: "192.168.1.9" },
      { address: "8.8.8.8" },
    ]),
    /invalid_camera_source/,
  );
});
test("simultaneous owners share one producer and cannot renew or release another owner", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.sessions.acquire(input()),
    f.sessions.acquire(input({ owner: other })),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(f.added.length, 1);
  assert.equal(f.rings.length, 1);
  assert.equal(JSON.stringify(a).includes("private-password"), false);
  assert.throws(
    () => f.sessions.renew(a.id, "unrelated-owner-123456"),
    /not_found/,
  );
  await assert.rejects(
    f.sessions.release(a.id, "unrelated-owner-123456"),
    /not_found/,
  );
  await f.sessions.release(a.id, owner);
  assert.equal(f.sessions.sessions.size, 1);
  await f.sessions.release(a.id, other);
  assert.equal(f.sessions.sessions.size, 0);
});
test("secret rotation uses a new producer while old leases remain independently owned", async (t) => {
  const f = await fixture(t),
    a = await f.sessions.acquire(input());
  const b = await f.sessions.acquire(
    input({
      source: {
        kind: "p2p-restream",
        url: "rtsp://name:new-password@192.168.1.9/stream",
      },
    }),
  );
  assert.notEqual(a.id, b.id);
  assert.equal(f.sessions.sessions.size, 2);
  await f.sessions.release(a.id, owner);
  assert.equal(f.sessions.sessions.has(b.id), true);
  assert.equal(f.sessions.byCamera.get("camera.fixture").id, b.id);
});
test("capacity is reserved before asynchronous startup and expired leases release producers", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    f.sessions.acquire(input()),
    f.sessions.acquire(input({ cameraId: "camera.second" })),
  ]);
  await assert.rejects(
    f.sessions.acquire(input({ cameraId: "camera.third" })),
    /busy/,
  );
  f.advance(60001);
  await f.sessions.tick();
  assert.equal(f.sessions.sessions.size, 0);
  assert.equal(f.removed.length, 2);
});
test("legacy relays share admission and only one rotation slot transfers owners after readiness", async (t) => {
  const f = await fixture(t);
  f.sessions.otherStreams = () => 1;
  const old = await f.sessions.acquire(input());
  await assert.rejects(
    f.sessions.acquire(input({ cameraId: "camera.second" })),
    /busy/,
  );
  const replacement = await f.sessions.acquire(
    input({
      source: {
        kind: "p2p-restream",
        url: "rtsp://new:private-secret@192.168.1.9/live",
      },
    }),
  );
  assert.equal(f.sessions.sessions.size, 2);
  await assert.rejects(
    f.sessions.acquire(
      input({
        source: {
          kind: "p2p-restream",
          url: "rtsp://next:private-secret@192.168.1.9/live",
        },
      }),
    ),
    /busy/,
  );
  f.advance(59000);
  assert.equal(f.sessions.renew(old.id, owner).id, replacement.id);
  f.advance(2000);
  await f.sessions.tick();
  assert.equal(f.sessions.sessions.has(old.id), false);
  assert.equal(f.sessions.sessions.has(replacement.id), true);
});
test("video-only readiness is opt-in and absent audio never becomes a fabricated track", () => {
  let at = 100000;
  const ring = new CameraRing("/unused", "rtsp://127.0.0.1/fixture", {
    now: () => at,
    requireAudio: false,
  });
  ring.metadata = { video: true, audio: false };
  ring.metadataAt = at;
  ring.freshAt = at;
  assert.equal(ring.ready(), true);
  ring.requireAudio = true;
  assert.equal(ring.ready(), false);
  ring.metadata.audio = true;
  assert.equal(ring.ready(), true);
  at += 10001;
  assert.equal(ring.ready(), false);
});
test("signed session RPC enforces owner isolation, pre-roll and secret-free status", async (t) => {
  const f = await fixture(t),
    key = "fixture-camera-pairing-key-123456789";
  const server = createNode({
    key,
    nodeId: "fixture",
    blobs: { status: async () => ({ usedBytes: 0 }) },
    cameras: f.sessions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (path, value, method = "POST") => {
    const text = JSON.stringify(value);
    return fetch(base + path, {
      method,
      body: text,
      headers: sign(
        key,
        method,
        path,
        createHash("sha256").update(text).digest("hex"),
      ),
    });
  };
  assert.equal(
    (
      await fetch(base + "/v1/cameras/sessions", {
        method: "POST",
        body: JSON.stringify(input()),
      })
    ).status,
    401,
  );
  const opened = await (await rpc("/v1/cameras/sessions", input())).json();
  const path = `/v1/cameras/sessions/${opened.id}`;
  assert.equal((await rpc(path + "/lease", { owner: other })).status, 404);
  assert.equal((await rpc(path + "/lease", { owner }, "DELETE")).status, 405);
  const eventId = randomUUID();
  await rpc(path + "/recordings", {
    owner,
    eventId,
    startAt: 100000,
    endAt: 120000,
  });
  assert.equal(f.rings[0].jobs.get(eventId).startAt, 92000);
  const status = await (
    await fetch(base + "/v1/status", {
      headers: sign(key, "GET", "/v1/status"),
    })
  ).json();
  assert.equal(status.rtspSessions.profile, 1);
  assert.equal(JSON.stringify(status).includes("private-password"), false);
});
test("stream-copy ring tolerates file-write jitter but rejects real missing footage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-ring-fixture-"));
  let at = 100000;
  const reservations = [];
  const diagnostics = [];
  const ring = new CameraRing(root, "rtsp://127.0.0.1:8554/fixture", {
    now: () => at,
    log: (event, fields) => diagnostics.push({ event, ...fields }),
    reserve: async (bytes) => {
      reservations.push(bytes);
      return () => reservations.splice(reservations.indexOf(bytes), 1);
    },
    spawnProcess: (_file, args) => {
      assert.equal(args.includes("copy"), true);
      assert.equal(args.includes("libx264"), false);
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("close", 0));
      };
      return child;
    },
  });
  t.after(async () => {
    await ring.stop();
    await rm(root, { recursive: true, force: true });
  });
  await ring.start();
  await cameraProcess("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "ultrafast",
    "-g",
    "40",
    "-c:a",
    "aac",
    "-f",
    "segment",
    "-segment_format",
    "mpegts",
    "-segment_time",
    "2",
    "-reset_timestamps",
    "1",
    "-segment_list",
    join(root, "segments.csv"),
    "-segment_list_type",
    "csv",
    join(root, "%09d.ts"),
  ]);
  for (let i = 0; i < 6; i++) {
    // Real P2P delivery and filesystem scheduling move close mtimes without
    // introducing a gap in the encoded media clock. The old per-file clock
    // mapping rejected these complete recordings as incomplete.
    const timestamp = 90 + i * 2 + (i % 2 ? 0.8 : 0);
    await utimes(
      join(root, `${String(i).padStart(9, "0")}.ts`),
      timestamp,
      timestamp,
    );
  }
  await ring.sample();
  assert.equal(ring.ready(), true);
  const eventId = randomUUID();
  await ring.record({ eventId, startAt: 92000, endAt: 100000 });
  at = 103000;
  await ring.sample();
  await ring.finalizing;
  const job = ring.jobs.get(eventId);
  assert.equal(job.state, "ready");
  assert.equal(job.result.audio, true);
  assert.ok(job.result.mediaStartAt <= 92000);
  assert.ok(job.result.duration >= 8);
  const metadata = JSON.parse(
    await cameraProcess("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      job.output,
    ]),
  );
  assert.equal(
    metadata.streams.some((row) => row.codec_type === "audio"),
    true,
  );

  // Omitting a real media segment must still fail. The change is only the
  // wall-clock mapping; it must not turn an actual hole into a valid clip.
  const csv = await readFile(join(root, "segments.csv"), "utf8");
  await writeFile(
    join(root, "segments.csv"),
    csv
      .split("\n")
      .filter((_, index) => index !== 3)
      .join("\n"),
  );
  await ring.sample();
  const missingId = randomUUID();
  await ring.record({ eventId: missingId, startAt: 92000, endAt: 100000 });
  await ring.finalizing;
  assert.equal(ring.jobs.get(missingId).state, "failed");
  assert.equal(
    reservations.length,
    2,
    "failed capture releases its disk reservation after cleanup",
  );
  assert.deepEqual(diagnostics, [
    {
      event: "recording_finalization_failed",
      eventId: missingId,
      stage: "coverage",
      reason: "camera_recording_incomplete",
      parts: 3,
    },
  ]);
  assert.ok(
    (await stat(job.output)).size > 0,
    "a later failure cannot remove the earlier original",
  );
  await ring.stop();
  assert.equal(reservations.length, 0);
});

test("ring media clocks stay fixed across samples and restart independently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-ring-clock-"));
  const ring = new CameraRing(root, "rtsp://127.0.0.1:8554/fixture", {
    now: () => 108000,
    probe: async () => ({ video: true, audio: true, duration: 2 }),
  });
  t.after(async () => {
    await ring.stop();
    await rm(root, { recursive: true, force: true });
  });
  const files = [
    ["000000000000.ts", 102],
    ["000000000001.ts", 104.8],
    ["001000000000.ts", 108],
  ];
  for (const [name, at] of files) {
    await writeFile(join(root, name), "fixture");
    await utimes(join(root, name), at, at);
  }
  await writeFile(
    join(root, "segments-000.csv"),
    "000000000000.ts,0,2\n000000000001.ts,2,4\n",
  );
  await writeFile(join(root, "segments-001.csv"), "001000000000.ts,0,2\n");
  await ring.sample();
  assert.deepEqual(
    ring.segments.map((s) => [s.startAt, s.endAt]),
    [
      [100000, 102000],
      [102000, 104000],
      [106000, 108000],
    ],
  );
  assert.equal(ring.runClocks.size, 2);
  await utimes(join(root, "000000000000.ts"), 103, 103);
  await ring.sample();
  assert.deepEqual(
    ring.segments.map((s) => [s.startAt, s.endAt]),
    [
      [100000, 102000],
      [102000, 104000],
      [106000, 108000],
    ],
  );
});
