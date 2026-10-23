import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { NodeSettings, storageLimitFromEnvironment } from "../lib/settings.mjs";
import { Blobs } from "../lib/blobs.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

const key = "node-settings-test-key-not-production-32";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("new nodes are unlimited and explicitly supplied environment caps remain respected", async (t) => {
  const root = await fixture(t);
  assert.equal(storageLimitFromEnvironment(undefined), null);
  assert.equal(storageLimitFromEnvironment(""), null);
  assert.equal(storageLimitFromEnvironment("0"), null);
  assert.equal(storageLimitFromEnvironment("20"), 20 * 1024 ** 3);
  for (const value of ["-10", "NaN", "1e20", "1x"])
    assert.throws(() => storageLimitFromEnvironment(value));
  const settings = await new NodeSettings(join(root, "settings.json"), {
    environmentLimit: 200,
  }).initialize();
  assert.deepEqual(settings.status(), {
    storageLimitBytes: 200,
    source: "environment",
  });
  await settings.update({ storageLimitBytes: null });
  const restarted = await new NodeSettings(join(root, "settings.json"), {
    environmentLimit: 200,
  }).initialize();
  assert.deepEqual(restarted.status(), {
    storageLimitBytes: null,
    source: "user",
  });
  assert.equal((await stat(join(root, "settings.json"))).mode & 0o777, 0o600);
});
test("strict quota edits serialize and survive restart without accepting unrelated settings", async (t) => {
  const root = await fixture(t);
  const applied = [];
  const settings = await new NodeSettings(join(root, "settings.json"), {
    apply: (bytes) => applied.push(bytes),
  }).initialize();
  for (const value of [
    undefined,
    null,
    [],
    {},
    { storageLimitBytes: 0 },
    { storageLimitBytes: -1 },
    { storageLimitBytes: "10" },
    { storageLimitBytes: 1.1 },
    { storageLimitBytes: null, shell: "no" },
  ])
    await assert.rejects(settings.update(value), /invalid_settings/);
  await Promise.all([
    settings.update({ storageLimitBytes: 100 }),
    settings.update({ storageLimitBytes: 200 }),
    settings.update({ storageLimitBytes: null }),
  ]);
  assert.deepEqual(applied, [null, 100, 200, null]);
  assert.deepEqual(JSON.parse(await readFile(settings.file, "utf8")), {
    storageLimitBytes: null,
  });
});
test("unlimited means disk-bounded admission, keeps per-file limits and never deletes existing copies", async (t) => {
  const root = await fixture(t);
  const filesystem = async () => ({
    bavail: 1000,
    blocks: 2000,
    bfree: 1000,
    bsize: 1,
  });
  const blobs = new Blobs(root, { reserveBytes: 100, filesystem });
  await blobs.initialize();
  const bytes = Buffer.from("verified recording");
  await blobs.put(digest(bytes), Readable.from(bytes), bytes.length);
  assert.equal((await blobs.status()).storageLimitBytes, null);
  assert.equal((await blobs.status()).availableBytes, 900);
  assert.equal((await blobs.status()).maxBytes, bytes.length + 900);
  blobs.setLimit(1);
  assert.equal((await blobs.status()).availableBytes, 0);
  assert.equal((await blobs.info(digest(bytes))).size, bytes.length);
  await assert.rejects(blobs.reserveTransient(1), /storage_full/);
  blobs.setLimit(null);
  const release = await blobs.reserveTransient(800);
  await assert.rejects(blobs.reserveTransient(101), /storage_full/);
  release();
  assert.equal(blobs.reserved, 0);
  await assert.rejects(
    blobs.put(digest("file"), Readable.from(""), blobs.maxFileBytes + 1),
    /invalid_size/,
  );
});
test("settings endpoints require signed requests, verify body digest and return effective storage policy", async (t) => {
  const root = await fixture(t);
  const blobs = new Blobs(join(root, "blobs"), { reserveBytes: 0 });
  await blobs.initialize();
  const settings = await new NodeSettings(join(root, "settings.json"), {
    apply: (bytes, source) => blobs.setLimit(bytes, source),
  }).initialize();
  const server = createNode({ key, blobs, nodeId: "test", settings });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/v1/settings")).status, 401);
  const input = JSON.stringify({ storageLimitBytes: 12345 });
  const patch = await fetch(base + "/v1/settings", {
    method: "PATCH",
    body: input,
    headers: sign(key, "PATCH", "/v1/settings", digest(input)),
  });
  assert.equal(patch.status, 200);
  assert.deepEqual(await patch.json(), {
    storageLimitBytes: 12345,
    source: "user",
  });
  const tampered = await fetch(base + "/v1/settings", {
    method: "PATCH",
    body: JSON.stringify({ storageLimitBytes: null }),
    headers: sign(key, "PATCH", "/v1/settings", digest(input)),
  });
  assert.equal(tampered.status, 400);
  const state = await (
    await fetch(base + "/v1/status", {
      headers: sign(key, "GET", "/v1/status"),
    })
  ).json();
  assert.equal(state.settings.storageLimitBytes, 12345);
  assert.equal(state.storage.storageLimitBytes, 12345);
  assert.equal(state.storage.limitSource, "user");
});
