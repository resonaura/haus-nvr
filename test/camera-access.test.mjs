import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CameraAccess, cameraAccessKey } from "../lib/camera-access.mjs";
import { cameraSource } from "../lib/camera-source.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

test("a scoped camera key survives controller loss without becoming a node key; stored sources are encrypted and expiry/revocation are enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "haus-camera-access-"));
  const key = "fixture-root-key-with-at-least-32-bytes",
    id = "1".repeat(32),
    now = Date.now(),
    closes = [];
  const sessions = new Map(),
    byCamera = new Map(),
    viewers = new Map();
  const cameras = {
    stop: async () => {},
    source: cameraSource,
    sessions,
    byCamera,
    status: () => ({ active: sessions.size, max: 1, profile: 1 }),
    engine: {
      viewers,
      closeViewer: (id, owner) => {
        if (viewers.get(id)?.owner === owner) {
          viewers.delete(id);
          closes.push(id);
        }
      },
    },
    acquire: async (input) => {
      let session = byCamera.get(input.cameraId);
      if (!session) {
        session = {
          id: randomUUID(),
          owners: new Map(),
          ring: { ready: () => true },
        };
        sessions.set(session.id, session);
        byCamera.set(input.cameraId, session);
      }
      session.owners.set(input.owner, now + 60000);
      return { id: session.id, state: "ready", expiresAt: now + 60000 };
    },
    offer: async (_session, owner) => {
      const viewerId = randomUUID();
      viewers.set(viewerId, { owner });
      return { viewerId, answer: { type: "answer", sdp: "v=0\r\nfixture" } };
    },
    release: async (id, owner) => {
      sessions.get(id)?.owners.delete(owner);
      for (const [id, viewer] of viewers)
        if (viewer.owner === owner) cameras.engine.closeViewer(id, owner);
    },
  };
  const path = join(root, "access.enc");
  const access = await new CameraAccess(path, key, cameras).initialize();
  const input = {
    id,
    cameraId: "camera.fixture",
    advertiseHost: "192.168.5.117",
    source: {
      kind: "p2p-restream",
      url: "rtsp://user:private-camera-secret@192.168.5.3:8556/camera",
    },
    expiresAt: now + 60000,
    preRollSeconds: 8,
    requireAudio: true,
    recordAudio: true,
    batteryPowered: false,
  };
  const server = createNode({
    key,
    nodeId: "fixture",
    instanceId: randomUUID(),
    cameras,
    cameraAccess: access,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (
    path,
    data,
    signingKey,
    method = "POST",
    delegated = true,
  ) => {
    const bytes =
      data === undefined
        ? undefined
        : JSON.stringify(
            path.startsWith("/v1/client/")
              ? { clientSession: "f".repeat(16), ...data }
              : data,
          );
    return fetch(base + path, {
      method,
      headers: {
        ...sign(
          signingKey,
          method,
          path,
          createHash("sha256")
            .update(bytes ?? "")
            .digest("hex"),
        ),
        ...(delegated ? { "x-haus-camera-access": id } : {}),
        ...(bytes ? { "Content-Type": "application/json" } : {}),
      },
      body: bytes,
    });
  };
  try {
    const issued = await request(
      "/v1/camera-access",
      input,
      key,
      "POST",
      false,
    );
    assert.equal(issued.status, 201);
    assert.equal(JSON.stringify(await issued.json()).includes("secret"), false);
    assert.equal(
      (await readFile(path)).includes(Buffer.from("private-camera-secret")),
      false,
    );
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal(
      (await new CameraAccess(path, key, cameras).initialize()).grants.size,
      1,
    );
    const clientKey = cameraAccessKey(key, id, input.cameraId, input.expiresAt);
    const signedPath = "/v1/client/camera/status";
    const replay = {
      ...sign(clientKey, "GET", signedPath),
      "x-haus-camera-access": id,
    };
    assert.equal(
      (await fetch(base + signedPath, { headers: replay })).status,
      200,
    );
    assert.equal(
      (await fetch(base + signedPath, { headers: replay })).status,
      401,
    );
    const untouched = JSON.stringify({
      clientSession: "f".repeat(16),
      active: true,
      preview: true,
    });
    const modified = JSON.stringify({
      clientSession: "f".repeat(16),
      active: false,
      preview: true,
    });
    const tampered = await fetch(base + "/v1/client/camera/warm", {
      method: "POST",
      headers: {
        ...sign(
          clientKey,
          "POST",
          "/v1/client/camera/warm",
          createHash("sha256").update(untouched).digest("hex"),
        ),
        "x-haus-camera-access": id,
      },
      body: modified,
    });
    assert.equal(tampered.ok, false);
    assert.equal(sessions.size, 0);
    assert.equal(
      (await request("/v1/status", undefined, clientKey, "GET")).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/v1/camera-access",
          { ...input, cameraId: "camera.other" },
          clientKey,
        )
      ).status,
      401,
    );
    const warm = await request(
      "/v1/client/camera/warm",
      {
        active: true,
        preview: true,
        cameraId: "camera.other",
        source: { kind: "rtsp", url: "rtsp://public.invalid/" },
      },
      clientKey,
    );
    assert.equal(warm.status, 200);
    assert.ok(byCamera.has("camera.fixture"));
    assert.equal(byCamera.has("camera.other"), false);
    const viewerId = randomUUID();
    const secondViewer = randomUUID();
    assert.equal(
      (
        await request(
          "/v1/client/camera/viewer",
          {
            clientSession: "e".repeat(16),
            viewerId: secondViewer,
            offer: "v=0\r\nfixture",
          },
          clientKey,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/v1/client/camera/viewer",
          { viewerId, offer: "v=0\r\nfixture" },
          clientKey,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/v1/client/camera/warm",
          { active: false, preview: true },
          clientKey,
        )
      ).status,
      200,
    );
    assert.equal(
      viewers.size,
      2,
      "preview release cannot stop an independent viewer",
    );
    assert.equal(
      (await request("/v1/client/camera/close", { viewerId }, clientKey))
        .status,
      200,
    );
    assert.equal(
      viewers.size,
      1,
      "closing one app instance keeps another instance alive",
    );
    await access.provision(input);
    assert.equal(
      (await fetch(base + signedPath, { headers: replay })).status,
      401,
      "idempotent provisioning must not reset nonce replay protection",
    );
    const deniedPolicy = await request(
      "/v1/camera-access/reconcile",
      { cameras: [] },
      clientKey,
    );
    assert.equal(deniedPolicy.status, 401);
    const policy = await request(
      "/v1/camera-access/reconcile",
      { cameras: [] },
      key,
      "POST",
      false,
    );
    assert.equal(policy.status, 200);
    assert.deepEqual(await policy.json(), { revoked: 1 });
    assert.equal(viewers.size, 0);
    assert.equal(
      (await request("/v1/client/camera/warm", { active: true }, clientKey))
        .status,
      401,
    );
    assert.equal(
      (await new CameraAccess(path, key, cameras).initialize()).grants.size,
      0,
    );
    await access.provision(input);
    const expired = new CameraAccess(path, key, cameras, {
      now: () => input.expiresAt + 1,
    });
    await expired.initialize();
    assert.equal(expired.grants.size, 0);
    await assert.rejects(
      new CameraAccess(path, "different-private-key", cameras).initialize(),
      /unlocked/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
