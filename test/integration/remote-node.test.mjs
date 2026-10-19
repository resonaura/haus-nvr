import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { sign } from "../../lib/auth.mjs";
const base = process.env.HAUS_NVR_TEST_URL;
const keyFile = process.env.HAUS_NVR_TEST_KEY_FILE;
test(
  "a provisioned container authenticates, stores a recording index and serves scoped byte ranges",
  { skip: !base || !keyFile },
  async () => {
    const key = (await readFile(keyFile, "utf8")).trim();
    const bytes = Buffer.alloc(1024 * 1024, 73),
      digest = createHash("sha256").update(bytes).digest("hex");
    const request = (path, method = "GET", payload) =>
      fetch(new URL(path, base), {
        method,
        headers: sign(
          key,
          method,
          path,
          payload
            ? createHash("sha256").update(payload).digest("hex")
            : undefined,
        ),
        body: payload,
        signal: AbortSignal.timeout(15000),
      });
    const status = await (await request("/v1/status")).json();
    assert.equal(status.protocol, 1);
    assert.equal((await fetch(new URL("/v1/status", base))).status, 401);
    const upload = await request(`/v1/blobs/${digest}`, "PUT", bytes);
    assert.ok([200, 201].includes(upload.status));
    await upload.body?.cancel();
    const id = process.env.HAUS_NVR_TEST_RECORDING_ID || randomUUID();
    const startAt = 1800000000000;
    const index = await request(
      "/v1/recordings",
      "POST",
      JSON.stringify({
        digest,
        event: {
          id,
          cameraId: "camera.validation_fixture",
          startAt,
          endAt: startAt + 40000,
          duration: 40,
          bytes: bytes.length,
          status: "ready",
          kinds: ["manual"],
        },
      }),
    );
    assert.equal(index.status, 201);
    await index.body?.cancel();
    assert.equal(
      (await (await request(`/v1/recordings/${id}`)).json()).digest,
      digest,
    );
    const grant = await (
      await request("/v1/grants", "POST", JSON.stringify({ digest }))
    ).json();
    assert.ok(!grant.path.includes(key));
    const range = await fetch(new URL(grant.path, base), {
      headers: { Range: "bytes=1024-2047" },
    });
    assert.equal(range.status, 206);
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      bytes.subarray(1024, 2048),
    );
    const forbidden = await fetch(new URL(grant.path, base), {
      method: "DELETE",
    });
    assert.equal(forbidden.status, 403);
    if (process.env.HAUS_NVR_TEST_KEEP_FIXTURE !== "1") {
      const removed = await request(`/v1/blobs/${digest}`, "DELETE");
      assert.equal(removed.status, 200);
      await removed.body?.cancel();
      assert.equal((await request(`/v1/recordings/${id}`)).status, 404);
    }
    console.log(
      JSON.stringify({
        nodeId: status.nodeId,
        instanceId: status.instanceId,
        recordingId: id,
        fixtureRetained: process.env.HAUS_NVR_TEST_KEEP_FIXTURE === "1",
      }),
    );
  },
);
