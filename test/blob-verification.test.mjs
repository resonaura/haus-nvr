import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  rename,
  truncate,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { get } from "node:http";
import { Blobs, blobPath } from "../lib/blobs.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

const key = "verification-test-pairing-key-long-enough";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "haus-blob-verify-"));
  const blobs = new Blobs(root, { reserveBytes: 0, ...options });
  await blobs.initialize();
  const server = createNode({ key, blobs, nodeId: "fixture" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const request = (path, method = "GET", options = {}) =>
    fetch(base + path, {
      method,
      headers: sign(key, method, path),
      ...options,
    });
  const put = async (bytes) => {
    const id = digest(bytes);
    await blobs.put(id, Readable.from(bytes), bytes.length);
    return id;
  };
  return { root, blobs, base, request, put };
}
function pauseRead() {
  let entered, resume;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    resume = resolve;
  });
  return {
    started,
    resume,
    read: async (handle, buffer, position) => {
      entered();
      await waiting;
      return handle.read(buffer, 0, buffer.length, position);
    },
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error("fixture deadline");
}

test("signed verification hashes persisted bytes every time and rejects missing/corrupt blobs", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("a stored camera recording"),
    id = await f.put(bytes),
    path = `/v1/blobs/${id}/verify`;
  assert.equal((await fetch(f.base + path, { method: "POST" })).status, 401);
  let response = await f.request(path, "POST");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    digest: id,
    bytes: bytes.length,
    verified: true,
  });
  await writeFile(blobPath(f.root, id), Buffer.alloc(bytes.length, 7));
  response = await f.request(path, "POST");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "digest_mismatch" });
  response = await f.request(`/v1/blobs/${"a".repeat(64)}/verify`, "POST");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "media_not_found" });
  assert.ok(
    !JSON.stringify(await (await f.request("/v1/status")).json()).includes(key),
  );
});

test("verification rejects replacement/truncation during hashing and never mutates persisted data", async (t) => {
  for (const action of ["replace", "truncate"]) {
    const paused = pauseRead(),
      f = await fixture(t, { verification: { read: paused.read } });
    const bytes = Buffer.alloc(512 * 1024, 3),
      id = await f.put(bytes);
    const pending = f.blobs.verify(id);
    await paused.started;
    if (action === "replace") {
      const next = join(f.root, "replacement");
      await writeFile(next, bytes);
      await rename(next, blobPath(f.root, id));
    } else await truncate(blobPath(f.root, id), 256);
    paused.resume();
    await assert.rejects(pending, /blob_changed/);
    assert.equal(
      (await readFile(blobPath(f.root, id))).length,
      action === "replace" ? bytes.length : 256,
    );
    assert.equal(f.blobs.readers.items.size, 0);
  }
});

test("one bounded verification holds a read lease, rejects concurrent DELETE, then releases safely", async (t) => {
  const paused = pauseRead(),
    f = await fixture(t, { verification: { read: paused.read } });
  const bytes = Buffer.from("verified existing bytes"),
    id = await f.put(bytes);
  const pending = f.blobs.verify(id);
  await paused.started;
  let response = await f.request(`/v1/blobs/${id}/verify`, "POST");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "verification_busy" });
  response = await f.request(`/v1/blobs/${id}`, "DELETE");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "blob_in_use" });
  assert.deepEqual(await readFile(blobPath(f.root, id)), bytes);
  paused.resume();
  assert.equal((await pending).verified, true);
  assert.equal(f.blobs.verification.active, 0);
  assert.equal((await f.request(`/v1/blobs/${id}`, "DELETE")).status, 200);
});
test("a delete already holding its exclusive lease cannot race a new verification", async (t) => {
  const f = await fixture(t),
    id = await f.put(Buffer.from("delete before verify"));
  const removing = f.blobs.remove(id);
  await assert.rejects(f.blobs.verify(id), /blob_in_use/);
  await removing;
  await assert.rejects(f.blobs.verify(id), /media_not_found/);
  assert.equal(f.blobs.readers.items.size, 0);
});

test("deadline responds promptly while a stalled read retains its bounded slot until unwound", async (t) => {
  const paused = pauseRead(),
    f = await fixture(t, {
      verification: { read: paused.read, timeoutMs: 30 },
    });
  const id = await f.put(Buffer.from("slow disk read"));
  const response = await f.request(`/v1/blobs/${id}/verify`, "POST");
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "verification_timeout" });
  assert.equal(f.blobs.verification.active, 1);
  await assert.rejects(f.blobs.remove(id), /blob_in_use/);
  paused.resume();
  await until(() => f.blobs.verification.active === 0);
  assert.equal(f.blobs.readers.items.size, 0);
});

test("client disconnect cancels verification and releases its reader once in-flight I/O ends", async (t) => {
  const paused = pauseRead(),
    f = await fixture(t, { verification: { read: paused.read } });
  const id = await f.put(Buffer.from("cancel this read")),
    abort = new AbortController();
  const pending = f.request(`/v1/blobs/${id}/verify`, "POST", {
    signal: abort.signal,
  });
  await paused.started;
  abort.abort();
  await assert.rejects(pending, /abort/i);
  paused.resume();
  await until(() => f.blobs.verification.active === 0);
  assert.equal(f.blobs.readers.items.size, 0);
});

test("active range playback is leased until its response disconnects", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(16 * 1024 * 1024, 5),
    id = await f.put(bytes);
  const path = `/v1/blobs/${id}`;
  const response = await new Promise((resolve, reject) => {
    const request = get(
      f.base + path,
      { headers: sign(key, "GET", path) },
      (res) => {
        res.pause();
        resolve(res);
      },
    );
    request.on("error", reject);
  });
  assert.equal((await f.request(path, "DELETE")).status, 409);
  response.destroy();
  await until(() => f.blobs.readers.items.size === 0);
  assert.equal((await f.request(path, "DELETE")).status, 200);
});

test("verification rejects symlink aliases, oversized persisted files and signed nonempty bodies", async (t) => {
  const f = await fixture(t, { maxFileBytes: 10 });
  const outside = join(f.root, "not-a-blob");
  await writeFile(outside, "12345");
  const id = digest("12345");
  await symlink(outside, blobPath(f.root, id));
  await assert.rejects(f.blobs.verify(id), /invalid_media|blob_changed/);
  const largeId = digest("12345678901");
  await writeFile(blobPath(f.root, largeId), "12345678901");
  await assert.rejects(f.blobs.verify(largeId), /invalid_media/);
  const path = `/v1/blobs/${id}/verify`,
    body = "{}";
  assert.equal(
    (
      await f.request(path, "POST", {
        body,
        headers: sign(key, "POST", path, digest(body)),
      })
    ).status,
    400,
  );
  assert.equal(f.blobs.verification.active, 0);
});
