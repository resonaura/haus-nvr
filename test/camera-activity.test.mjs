import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CameraActivity } from "../lib/camera-activity.mjs";
import { CameraSessions } from "../lib/camera-sessions.mjs";
import { Detectors } from "../lib/detectors.mjs";

test("explicit Assist assignment survives controller lease loss, shares one producer, creates/extends canonical pre-event IDs and revokes cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-autonomous-activity-"));
  let at = Date.now(),
    added = 0,
    workerOptions,
    stopped = 0;
  const engine = {
    viewers: new Map(),
    initialize: async () => {},
    add: async () => {
      added++;
    },
    remove: async () => {},
    localRtsp: () => "rtsp://127.0.0.1:8554/private",
    stop: async () => {},
  };
  let ring;
  const cameras = await new CameraSessions(join(root, "sessions"), engine, {
    max: 1,
    now: () => at,
    ring: () => {
      ring = {
        jobs: new Map(),
        freshAt: at,
        ready: () => true,
        start: async () => {},
        stop: async () => {},
        sample: async () => {},
        record: async (value) => {
          const old = ring.jobs.get(value.eventId);
          ring.jobs.set(value.eventId, {
            ...value,
            id: value.eventId,
            state: "recording",
          });
          return old ?? value;
        },
      };
      return ring;
    },
  }).initialize();
  const capacity = {
    detectors: 1,
    memory: 512,
    memoryUsed: 64,
    pressured: false,
  };
  const detectors = new Detectors(undefined, capacity, {
    now: () => at,
    worker: (options) => {
      workerOptions = options;
      return {
        state: "running",
        calibrated: true,
        lastResult: at,
        stop: async () => {
          stopped++;
        },
      };
    },
  });
  detectors.supported = true;
  detectors.sessions = cameras;
  const path = join(root, "activity.enc"),
    key = "private-node-key-fixture-123456789";
  let activity = await new CameraActivity(path, key, cameras, detectors, {
    now: () => at,
  }).initialize();
  t.after(async () => {
    await activity.stop();
    await detectors.stop();
    await cameras.stop();
    await rm(root, { recursive: true, force: true });
  });
  const plan = {
    cameraId: "camera.fixture",
    source: {
      kind: "p2p-restream",
      url: "rtsp://u:secret-p2p@192.168.1.9:8556/live",
    },
    advertiseHost: "192.168.1.5",
    preRollSeconds: 8,
    requireAudio: true,
    recordAudio: true,
    expiresAt: at + 86400000,
    policyId: randomUUID(),
    mode: "objects",
    postRollSeconds: 20,
    maxEventSeconds: 300,
  };
  assert.equal(
    detectors.jobs.size,
    0,
    "Assist stays off until an explicit valid policy",
  );
  await cameras.acquire({ ...plan, owner: "controller-recording-fixture" });
  await activity.update([plan]);
  assert.equal(added, 1);
  assert.equal(detectors.jobs.size, 1);
  assert.equal(workerOptions.source, "rtsp://127.0.0.1:8554/private");
  assert.equal(
    (await readFile(path)).includes(Buffer.from("secret-p2p")),
    false,
  );
  at += 40000;
  await activity.tick();
  at += 25000;
  ring.freshAt = at;
  await cameras.tick();
  await activity.tick();
  assert.equal(added, 1);
  assert.equal(cameras.sessions.size, 1);
  assert.equal(detectors.jobs.size, 1);
  workerOptions.onDetection({ kind: "person", at });
  await activity.tick();
  const first = activity.status().cameras[0].events.at(-1);
  assert.ok(first.recordedEventId);
  assert.equal(first.recordingManaged, true);
  const capture = ring.jobs.get(first.recordedEventId);
  assert.equal(capture.startAt, at - 8000);
  assert.equal(capture.metadata.startAt, at);
  assert.equal(capture.metadata.origin.policyId, plan.policyId);
  const requestId = randomUUID();
  const native = {
    cameraId: plan.cameraId,
    policyId: plan.policyId,
    requestId,
    kind: "person",
    at,
  };
  const accepted = await activity.trigger(native);
  assert.equal(
    accepted.recordedEventId,
    first.recordedEventId,
    "native and software activity share the same capture",
  );
  assert.deepEqual(await activity.trigger(native), accepted);
  assert.equal(ring.jobs.size, 1);
  at += 4000;
  workerOptions.onDetection({ kind: "pet", at });
  await activity.tick();
  assert.equal(ring.jobs.size, 1);
  assert.equal(ring.jobs.get(first.recordedEventId).endAt, at + 20000);
  capacity.detectors = 0;
  await detectors.remove(activity.jobs.get(plan.cameraId).detectorId);
  at += 4000;
  await activity.tick();
  assert.equal(detectors.jobs.size, 0);
  assert.equal(activity.status().cameras[0].state, "waiting");
  const fallback = await activity.trigger({
    ...native,
    requestId: randomUUID(),
    kind: "doorbell",
    at,
  });
  assert.equal(
    fallback.recordedEventId,
    first.recordedEventId,
    "native semantic capture stays available when analysis has no quota",
  );
  assert.equal(cameras.sessions.size, 1);
  capacity.detectors = 1;
  at += 10001;
  await activity.tick();
  assert.equal(detectors.jobs.size, 1);
  at += 301000;
  ring.freshAt = at;
  workerOptions.onDetection({ kind: "person", at });
  await activity.tick();
  assert.equal(
    ring.jobs.size,
    2,
    "maximum event duration rotates the event ID",
  );
  await assert.rejects(
    activity.update([{ ...plan, mode: "all-pixels" }]),
    /invalid_camera_activity/,
  );
  assert.equal(detectors.jobs.size, 1);
  await activity.stop();
  assert.equal(detectors.jobs.size, 0);
  activity = await new CameraActivity(path, key, cameras, detectors, {
    now: () => at,
  }).initialize();
  for (let i = 0; i < 30 && activity.busy; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    detectors.jobs.size,
    1,
    "encrypted explicit policy restores after the node policy manager restarts",
  );
  await activity.update([]);
  assert.equal(detectors.jobs.size, 0);
  assert.ok(stopped >= 2);
  assert.equal(activity.status().cameras.length, 0);
  await activity.update([plan]);
  at = plan.expiresAt + 1;
  await activity.tick();
  assert.equal(
    detectors.jobs.size,
    0,
    "expired policy cannot keep inference alive",
  );
});
