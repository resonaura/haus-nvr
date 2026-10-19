import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Blobs } from "../lib/blobs.mjs";
import { createNode } from "../lib/server.mjs";
import { sign, authenticator } from "../lib/auth.mjs";
const key = "test-only-node-key-32-characters-long";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-nvr-"));
  const blobs = new Blobs(root, { maxBytes: 10000, reserveBytes: 0 });
  await blobs.initialize();
  const server = createNode({ key, blobs, nodeId: "test" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  return { base, blobs, root };
}
test("auth rejects replay, stale timestamps, path and body tampering", () => {
  const auth = authenticator(key);
  const path = "/v1/status";
  const headers = sign(key, "GET", path);
  assert.equal(auth({ method: "GET", url: path, headers }), true);
  assert.equal(auth({ method: "GET", url: path, headers }), false);
  assert.equal(
    auth({
      method: "GET",
      url: path,
      headers: sign(key, "GET", path, undefined, Date.now() - 120000),
    }),
    false,
  );
  assert.equal(
    auth({ method: "DELETE", url: path, headers: sign(key, "GET", path) }),
    false,
  );
});
test("verified uploads, seekable ranges, duplicate uploads and restart accounting", async (t) => {
  const { base, blobs, root } = await fixture(t);
  assert.equal((await fetch(base + "/v1/status")).status, 401);
  const bytes = Buffer.from("0123456789");
  const path = "/v1/blobs/" + hash(bytes);
  const upload = () =>
    fetch(base + path, {
      method: "PUT",
      body: bytes,
      headers: sign(key, "PUT", path, hash(bytes)),
    });
  assert.equal((await upload()).status, 201);
  assert.equal((await upload()).status, 200);
  const res = await fetch(base + path, {
    headers: { ...sign(key, "GET", path), Range: "bytes=3-6" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 3-6/10");
  assert.equal(await res.text(), "3456");
  assert.equal(blobs.used, 10);
  const restarted = new Blobs(root);
  await restarted.initialize();
  assert.equal(restarted.used, 10);
  assert.equal(
    (
      await fetch(base + path, {
        headers: { ...sign(key, "GET", path), Range: "bytes=100-" },
      })
    ).status,
    416,
  );
});
test("corrupt uploads and storage exhaustion do not leave committed files", async (t) => {
  const { base, blobs, root } = await fixture(t);
  const id = hash("expected");
  const path = "/v1/blobs/" + id;
  const bad = await fetch(base + path, {
    method: "PUT",
    body: "wrong",
    headers: sign(key, "PUT", path, id),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await readdir(root), []);
  const big = Buffer.alloc(11000);
  const response = await fetch(base + "/v1/blobs/" + hash(big), {
    method: "PUT",
    body: big,
    headers: sign(key, "PUT", "/v1/blobs/" + hash(big), hash(big)),
  });
  assert.equal(response.status, 507);
  assert.equal(blobs.used, 0);
});
test("two concurrent identical uploads are accounted only once", async (t) => {
  const { base, blobs } = await fixture(t);
  const bytes = Buffer.alloc(4000, 3),
    id = hash(bytes),
    path = "/v1/blobs/" + id;
  const results = await Promise.all(
    [1, 2].map(() =>
      fetch(base + path, {
        method: "PUT",
        body: bytes,
        headers: sign(key, "PUT", path, id),
      }),
    ),
  );
  assert.ok(results.every((r) => r.ok));
  assert.equal(blobs.used, 4000);
  assert.equal(blobs.reserved, 0);
});
