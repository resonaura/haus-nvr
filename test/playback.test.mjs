import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { Playback } from "../lib/playback.mjs";
import { Blobs, blobPath } from "../lib/blobs.mjs";
import { createNode } from "../lib/server.mjs";
import { sign } from "../lib/auth.mjs";

const key = "test-only-node-key-32-characters-long";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "haus-playback-"));
  const blobs = new Blobs(join(root, "blobs"), {
    maxBytes: 2 * 1024 ** 2,
    reserveBytes: 0,
  });
  await blobs.initialize();
  const original = Buffer.from("original-unmodified-media");
  const source = digest(original);
  await blobs.put(source, Readable.from(original), original.length);
  const capacity = { cpus: 2, memory: 1024 ** 3, pressured: false };
  const playback = new Playback(join(root, "work"), blobs, capacity, {
    maxBytes: 1024,
    ...options,
  });
  await playback.initialize();
  const server = createNode({ key, blobs, playback, nodeId: "test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await playback.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const request = (path, method = "GET", data) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    return fetch(base + path, {
      method,
      body,
      headers: sign(key, method, path, body ? digest(body) : undefined),
    });
  };
  return {
    root,
    blobs,
    original,
    source,
    playback,
    capacity,
    base,
    request,
    input: { digest: source, profile: 1, audioTrimSeconds: 0 },
  };
}

test("authenticated preparation coalesces pending work, verifies result bytes and releases temporary storage", async (t) => {
  let complete,
    calls = 0;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const bytes = Buffer.from("prepared-video-with-audio");
  const f = await fixture(t, {
    encode: async ({ output, signal }) => {
      calls++;
      await pending;
      signal.throwIfAborted();
      await writeFile(output, bytes);
      return { duration: 2, width: 160, height: 90, audio: true };
    },
  });
  t.after(() => complete());
  assert.equal(
    (
      await fetch(f.base + "/v1/playback", {
        method: "POST",
        body: JSON.stringify(f.input),
      })
    ).status,
    401,
  );
  const first = await f.request("/v1/playback", "POST", f.input);
  assert.equal(first.status, 202);
  const job = await first.json();
  const duplicate = await (
    await f.request("/v1/playback", "POST", f.input)
  ).json();
  assert.equal(duplicate.id, job.id);
  for (let i = 0; i < 20 && !calls; i++) await pause(5);
  assert.equal(calls, 1);
  assert.equal(
    (await f.request(`/v1/blobs/${f.source}`, "DELETE")).status,
    409,
  );
  assert.equal(
    (
      await f.request("/v1/playback", "POST", {
        ...f.input,
        audioTrimSeconds: 1,
      })
    ).status,
    507,
  );
  assert.equal((await f.request(`/v1/playback/${job.id}/media`)).status, 409);
  assert.equal(f.blobs.reserved, 1024);
  complete();
  await f.playback.jobs.get(job.id).pending;
  const status = await f.request(`/v1/playback/${job.id}`);
  assert.equal(status.status, 200);
  const result = await status.json();
  assert.equal(result.digest, digest(bytes));
  assert.equal(result.audio, true);
  const media = await f.request(`/v1/playback/${job.id}/media`);
  assert.equal(media.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
  assert.equal(
    (await f.request(`/v1/playback/${job.id}`, "DELETE")).status,
    200,
  );
  assert.equal(f.blobs.reserved, 0);
  assert.deepEqual(await readdir(join(f.root, "work")), []);
  assert.deepEqual(
    await readFile(blobPath(f.blobs.root, f.source)),
    f.original,
  );
  assert.equal((await f.request(`/v1/playback/${job.id}`)).status, 404);
});

test("a helper-verified legacy silent lead beyond ten minutes reaches the bounded encoder", async (t) => {
  let supplied;
  const f = await fixture(t, {
    encode: async ({ output, audioTrimSeconds }) => {
      supplied = audioTrimSeconds;
      await writeFile(output, "prepared-with-real-audio");
      return { duration: 30.15, width: 2304, height: 1296, audio: true };
    },
  });
  const response = await f.request("/v1/playback", "POST", {
    ...f.input,
    audioTrimSeconds: 943.418,
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  await f.playback.jobs.get(job.id).pending;
  assert.equal(supplied, 943.418);
  assert.equal((await f.request(`/v1/playback/${job.id}`)).status, 200);
  assert.deepEqual(
    await readFile(blobPath(f.blobs.root, f.source)),
    f.original,
  );
});

test("weak or pressured workers refuse encoding and job forms cannot contain URLs or arbitrary encoder flags", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    encode: async () => {
      calls++;
    },
  });
  for (const [cpus, memory, pressured] of [
    [0.75, 1024 ** 3, false],
    [2, 512 * 1024 ** 2, false],
    [2, 1024 ** 3, true],
  ]) {
    Object.assign(f.capacity, { cpus, memory, pressured });
    assert.equal(f.playback.status().max, 0);
    assert.equal(
      (await f.request("/v1/playback", "POST", f.input)).status,
      507,
    );
  }
  for (const input of [
    { ...f.input, url: "http://private-target/" },
    { ...f.input, args: ["-i", "/etc/passwd"] },
    { ...f.input, audioTrimSeconds: -1 },
    { ...f.input, audioTrimSeconds: 86400.001 },
    { ...f.input, audioTrimSeconds: "943.418" },
    { ...f.input, profile: 2 },
    { ...f.input, digest: "../file" },
  ])
    assert.equal((await f.request("/v1/playback", "POST", input)).status, 400);
  assert.equal(calls, 0);
  assert.equal(f.blobs.reserved, 0);
});

test("cancellation and encoder failure leave originals intact, hide private errors and reclaim reservations", async (t) => {
  let now = 0;
  const f = await fixture(t, {
    now: () => now,
    encode: async ({ signal }) => {
      await new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("private-camera-url")),
          { once: true },
        ),
      );
    },
  });
  const job = f.playback.start(f.input);
  for (let i = 0; i < 20 && !f.blobs.reserved; i++) await pause(5);
  await f.playback.remove(job.id);
  assert.equal(f.blobs.reserved, 0);
  assert.equal(f.playback.status().active, 0);
  f.playback.encode = async () => {
    throw new Error("http://secret:password@private-camera/");
  };
  const failed = f.playback.start(f.input);
  await f.playback.jobs.get(failed.id).pending;
  const response = await f.request(`/v1/playback/${failed.id}`);
  assert.equal(response.status, 503);
  const raw = await response.text();
  assert.ok(!raw.includes("password") && !raw.includes("private-camera"));
  assert.equal(f.blobs.reserved, 0);
  now = 5001;
  await f.playback.prune();
  assert.equal(f.playback.jobs.size, 0);
  assert.deepEqual(
    await readFile(blobPath(f.blobs.root, f.source)),
    f.original,
  );
});

test("temporary reservations share the upload budget, release exactly once and reject oversized results", async (t) => {
  const f = await fixture(t, {
    encode: async ({ output }) => {
      await writeFile(output, Buffer.alloc(1025));
      return { duration: 2, audio: true };
    },
  });
  const release = await f.blobs.reserveTransient(1024 ** 2 + 1);
  await assert.rejects(
    () => f.blobs.reserveTransient(1024 ** 2),
    /storage_full/,
  );
  release();
  release();
  assert.equal(f.blobs.reserved, 0);
  const job = f.playback.start(f.input);
  await f.playback.jobs.get(job.id).pending;
  assert.equal(f.playback.jobs.get(job.id).state, "failed");
  assert.equal(f.blobs.reserved, 0);
  assert.deepEqual(await readdir(join(f.root, "work")), []);
});

test("restart removes only abandoned owned work directories", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "restart");
  await mkdir(root);
  await mkdir(join(root, "00000000-0000-4000-8000-000000000000"));
  await writeFile(join(root, "keep.txt"), "unrelated");
  const restarted = new Playback(root, f.blobs, f.capacity);
  await restarted.initialize();
  await restarted.stop();
  assert.deepEqual(await readdir(root), ["keep.txt"]);
});

test("expired prepared work releases its storage without removing the source blob", async (t) => {
  let now = 0;
  const f = await fixture(t, {
    now: () => now,
    encode: async ({ output }) => {
      await writeFile(output, "prepared");
      return { duration: 2, audio: true };
    },
  });
  const job = f.playback.start(f.input);
  await f.playback.jobs.get(job.id).pending;
  assert.equal(f.blobs.reserved, 1024);
  now = 900001;
  await f.playback.prune();
  assert.equal(f.blobs.reserved, 0);
  assert.equal(f.playback.jobs.size, 0);
  assert.deepEqual(
    await readFile(blobPath(f.blobs.root, f.source)),
    f.original,
  );
});
