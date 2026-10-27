import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraSessions } from "../lib/camera-sessions.mjs";
import { CameraContinuity } from "../lib/camera-continuity.mjs";

test("an assigned producer survives controller lease loss, restarts from private policy, obeys capacity and stops on revocation/expiry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-continuity-"));
  let at = Date.now(),
    adds = 0;
  const engine = {
    viewers: new Map(),
    initialize: async () => {},
    add: async () => {
      adds++;
    },
    remove: async () => {},
    localRtsp: () => "rtsp://127.0.0.1:8554/local",
    stop: async () => {},
  };
  const create = async () =>
    new CameraSessions(join(root, "sessions"), engine, {
      max: 1,
      now: () => at,
      ring: () => ({
        jobs: new Map(),
        freshAt: at,
        start: async () => {},
        stop: async () => {},
        ready: () => true,
        sample: async () => {},
      }),
    }).initialize();
  const key = "fixture-private-node-key-more-than-32",
    path = join(root, "continuity.enc");
  let cameras = await create(),
    continuity = await new CameraContinuity(path, key, cameras, {
      now: () => at,
    }).initialize();
  t.after(async () => {
    await continuity.stop();
    await cameras.stop();
    await rm(root, { recursive: true, force: true });
  });
  const plan = {
    cameraId: "camera.fixture",
    source: {
      kind: "p2p-restream",
      url: "rtsp://u:source-secret@192.168.1.9:8556/live",
    },
    advertiseHost: "192.168.1.5",
    preRollSeconds: 8,
    requireAudio: true,
    recordAudio: true,
    expiresAt: at + 86400000,
  };
  const controller = await cameras.acquire({
    ...plan,
    owner: "recording-controller-fixture",
  });
  await continuity.update([plan]);
  assert.equal(cameras.sessions.size, 1);
  assert.equal(adds, 1);
  assert.equal(
    (await readFile(path)).includes(Buffer.from("source-secret")),
    false,
  );
  assert.equal((await stat(path)).mode & 0o077, 0);
  at += 40000;
  await continuity.tick();
  at += 25000;
  cameras.byCamera.get(plan.cameraId).ring.freshAt = at;
  await cameras.tick();
  assert.equal(cameras.byCamera.get(plan.cameraId).id, controller.id);
  assert.equal(
    cameras.byCamera
      .get(plan.cameraId)
      .owners.has("recording-controller-fixture"),
    false,
  );
  assert.equal(adds, 1, "controller loss must not restart the source");
  await continuity.stop();
  await cameras.stop();
  cameras = await create();
  continuity = await new CameraContinuity(path, key, cameras, {
    now: () => at,
  }).initialize();
  // initialize starts one asynchronous tick; await it through a bounded microtask drain.
  for (let i = 0; i < 20 && continuity.busy; i++)
    await new Promise((r) => setImmediate(r));
  assert.equal(cameras.sessions.size, 1);
  assert.equal(adds, 2);
  await continuity.update([plan, { ...plan, cameraId: "camera.second" }]);
  assert.equal(
    cameras.sessions.size,
    1,
    "persisted policy cannot bypass a one-source node",
  );
  assert.equal(
    continuity.status().cameras.find((c) => c.cameraId === "camera.second")
      .state,
    "waiting",
  );
  await assert.rejects(
    continuity.update([
      { ...plan, source: { kind: "rtsp", url: "rtsp://8.8.8.8/live" } },
    ]),
    /invalid_camera_source/,
  );
  assert.equal(
    continuity.status().cameras.length,
    2,
    "invalid replacement leaves prior policy intact",
  );
  await continuity.update([]);
  assert.equal(cameras.sessions.size, 0);
  await continuity.update([plan]);
  assert.equal(cameras.sessions.size, 1);
  at = plan.expiresAt + 1;
  await continuity.tick();
  assert.equal(cameras.sessions.size, 0);
  await continuity.stop();
  await assert.rejects(
    new CameraContinuity(path, "different-key", cameras).initialize(),
    /unlocked/,
  );
});
