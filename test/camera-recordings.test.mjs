import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Blobs, blobPath } from "../lib/blobs.mjs";
import { RecordingIndex } from "../lib/recording-index.mjs";
import {
  CameraRecordings,
  captureMetadata,
} from "../lib/camera-recordings.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

test("unfinished autonomous IDs and native intent deduplication survive abrupt restart without invented media", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-activity-journal-"));
  const blobs = new Blobs(join(root, "blobs"), { reserveBytes: 0 });
  await blobs.initialize();
  let index = new RecordingIndex(join(root, "recordings.sqlite"), blobs),
    outbox = await new CameraRecordings(
      join(root, "outbox"),
      index,
      blobs,
    ).initialize();
  t.after(async () => {
    await outbox.stop();
    index.close();
    await rm(root, { recursive: true, force: true });
  });
  const requestId = randomUUID(),
    event = {
      id: randomUUID(),
      cameraId: "camera.fixture",
      startAt: Date.now(),
      endAt: Date.now() + 20000,
      kinds: ["person"],
      origin: { kind: "camera-activity", policyId: randomUUID() },
    };
  outbox.beginActivity(event, requestId);
  assert.equal(
    outbox.activityRequest(event.cameraId, event.origin.policyId, requestId),
    event.id,
  );
  await outbox.stop();
  index.close();
  index = new RecordingIndex(join(root, "recordings.sqlite"), blobs);
  outbox = await new CameraRecordings(
    join(root, "outbox"),
    index,
    blobs,
  ).initialize();
  assert.equal(
    outbox.activityRequest(event.cameraId, event.origin.policyId, requestId),
    event.id,
    "a retried native intent must never create a second ID after restart",
  );
  assert.deepEqual(outbox.interruptedActivities().items, [
    { event, state: "interrupted", error: "node_restarted" },
  ]);
  assert.equal(
    index.get(event.id),
    null,
    "a journal entry is not a fabricated playable original",
  );
  assert.equal(outbox.get(event.id), null);
  outbox.acknowledgeInterrupted(event.id);
  assert.equal(outbox.interruptedActivities().items.length, 0);
});

test("finished original survives session cleanup, archive pressure, node restart and repeated recovery without replacing prepared media", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-capture-outbox-")),
    archive = join(root, "archive"),
    work = join(root, "work");
  await mkdir(work);
  const blobs = new Blobs(archive, {
    workspaceRoot: work,
    reserveBytes: 0,
    inspect: async (path) => ({ dev: path === archive ? 1 : 2 }),
  });
  await blobs.initialize();
  let index = new RecordingIndex(join(work, "recordings.sqlite"), blobs);
  let outbox = await new CameraRecordings(
    join(work, "outbox"),
    index,
    blobs,
  ).initialize();
  t.after(async () => {
    await outbox.stop();
    index.close();
    await rm(root, { recursive: true, force: true });
  });
  const data = Buffer.from("fixture-encoded-audio-video-original"),
    id = randomUUID(),
    sha256 = createHash("sha256").update(data).digest("hex"),
    output = join(work, "session.mp4");
  await writeFile(output, data);
  const metadata = captureMetadata(
    {
      id,
      cameraId: "camera.fixture",
      startAt: 10000,
      endAt: 20000,
      kinds: ["motion"],
    },
    "camera.fixture",
    10000,
    20000,
  );
  const job = {
    id,
    output,
    metadata,
    result: {
      bytes: data.length,
      sha256,
      duration: 18,
      mediaStartAt: 2000,
      audio: true,
    },
  };
  blobs.setLimit(0, "user");
  await outbox.preserve(job);
  await outbox.preserve(job);
  await rm(output);
  await outbox.tick();
  assert.equal(outbox.get(id).state, "archiving");
  assert.deepEqual(await readFile(join(work, "outbox", `${id}.mp4`)), data);
  assert.equal(outbox.pending(sha256), true);
  assert.equal((await stat(join(work, "outbox", `${id}.mp4`))).mode & 0o077, 0);
  await outbox.stop();
  index.close();
  index = new RecordingIndex(join(work, "recordings.sqlite"), blobs);
  outbox = await new CameraRecordings(
    join(work, "outbox"),
    index,
    blobs,
  ).initialize();
  await outbox.tick();
  assert.equal(outbox.get(id).state, "archiving");
  blobs.setLimit(null, "user");
  await outbox.tick();
  assert.equal(outbox.get(id).state, "ready");
  assert.equal(index.get(id).storageVariant, "original");
  assert.equal(index.get(id).mediaStartAt, 2000);
  assert.equal(index.get(id).playbackInfo.audio, true);
  assert.deepEqual(await readFile(blobPath(archive, sha256)), data);
  assert.equal(outbox.list().items.length, 1);
  assert.throws(() => outbox.acknowledge(id, "f".repeat(64)), /not_found/);
  outbox.acknowledge(id, sha256);
  outbox.acknowledge(id, sha256);
  assert.equal(outbox.list().items.length, 0);
  assert.equal(outbox.pending(sha256), false);
  assert.equal(blobs.workspaceReserved, 0);
  assert.equal(
    index.db.prepare("SELECT count(*) AS n FROM recordings").get().n,
    1,
  );
  await outbox.stop();
  index.close();
  index = new RecordingIndex(join(work, "recordings.sqlite"), blobs);
  outbox = await new CameraRecordings(
    join(work, "outbox"),
    index,
    blobs,
  ).initialize();
  assert.equal(
    outbox.list().items.length,
    0,
    "acknowledged capture must not reappear after restart",
  );
});

test("only root-authenticated recovery can list/ack originals and unacknowledged clips cannot be pruned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-capture-rpc-"));
  const blobs = new Blobs(join(root, "blobs"), { reserveBytes: 0 });
  await blobs.initialize();
  const index = new RecordingIndex(join(root, "recordings.sqlite"), blobs),
    outbox = await new CameraRecordings(
      join(root, "outbox"),
      index,
      blobs,
    ).initialize();
  const data = Buffer.from("audio-video"),
    sha256 = createHash("sha256").update(data).digest("hex"),
    id = randomUUID(),
    output = join(root, "capture.mp4"),
    event = {
      id,
      cameraId: "camera.fixture",
      startAt: 1000,
      endAt: 2000,
      kinds: ["manual"],
    };
  await writeFile(output, data);
  await outbox.preserve({
    id,
    output,
    metadata: event,
    result: {
      bytes: data.length,
      sha256,
      duration: 1,
      mediaStartAt: 1000,
      audio: true,
    },
  });
  await outbox.tick();
  const key = "root-controller-fixture-key-123456789",
    server = createNode({
      key,
      nodeId: "fixture",
      blobs,
      recordings: index,
      cameraRecordings: outbox,
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await outbox.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`,
    request = (method, path, input) => {
      const body = input === undefined ? undefined : JSON.stringify(input);
      return fetch(base + path, {
        method,
        body,
        headers: sign(
          key,
          method,
          path,
          body ? createHash("sha256").update(body).digest("hex") : undefined,
        ),
      });
    };
  assert.equal((await fetch(base + "/v1/camera-recordings")).status, 401);
  const grant = (
    await (await request("POST", "/v1/grants", { digest: sha256 })).json()
  ).path;
  assert.ok(grant);
  assert.equal(
    (await fetch(base + "/v1/camera-recordings?" + grant.split("?")[1])).status,
    401,
  );
  assert.equal((await request("GET", "/v1/camera-recordings")).status, 200);
  assert.equal((await request("DELETE", `/v1/blobs/${sha256}`)).status, 409);
  assert.equal(
    (
      await request("POST", `/v1/camera-recordings/${id}`, {
        sha256: "a".repeat(64),
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("POST", `/v1/camera-recordings/${id}`, { sha256 })).status,
    200,
  );
  assert.equal((await request("DELETE", `/v1/blobs/${sha256}`)).status, 200);
  assert.throws(
    () =>
      captureMetadata(
        { ...event, cameraId: "camera.another" },
        event.cameraId,
        1000,
        2000,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      captureMetadata(
        { ...event, kinds: ["invalid"] },
        event.cameraId,
        1000,
        2000,
      ),
    /invalid/,
  );
  assert.throws(() => outbox.list("-1"), /invalid_cursor/);
});
