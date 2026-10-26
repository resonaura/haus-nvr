import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  stat,
  statfs,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { sign } from "../lib/auth.mjs";
import { Blobs } from "../lib/blobs.mjs";

async function fixture(
  t,
  { free = 180, separate = true, backing = null } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "haus-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "work");
  await mkdir(workspaceRoot);
  let currentFree = free;
  let unavailable = false;
  const archive = join(root, "archive");
  const blobs = new Blobs(archive, {
    workspaceRoot,
    reserveBytes: 100,
    inspect: async (path) => ({ dev: path === archive || !separate ? 1 : 2 }),
    filesystem: async (path) => {
      if (path === workspaceRoot && unavailable) throw Error("unavailable");
      return {
        bavail: path === workspaceRoot ? currentFree : 10000,
        bsize: 1,
        blocks: 20000,
      };
    },
    workspaceBackingCapacity: async () => backing,
  });
  await blobs.initialize();
  return {
    blobs,
    archive,
    workspaceRoot,
    setFree: (n) => {
      currentFree = n;
    },
    setUnavailable: () => {
      unavailable = true;
    },
  };
}

test("a full working disk rejects temporary work even when the archive has space", async (t) => {
  const { blobs } = await fixture(t, { free: 120 });
  assert.ok((await blobs.status()).availableBytes > 1000);
  await assert.rejects(blobs.reserveTransient(32), /storage_full/);
  assert.equal(blobs.reserved, 0);
  assert.equal((await blobs.status()).workspace.availableBytes, 20);
});

test("concurrent working reservations cannot overbook a separate filesystem and release is idempotent", async (t) => {
  const { blobs } = await fixture(t, { free: 190 });
  const results = await Promise.allSettled([
    blobs.reserveTransient(50),
    blobs.reserveTransient(50),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await blobs.status()).workspace.reservedBytes, 50);
  const release = results.find((r) => r.status === "fulfilled").value;
  release();
  release();
  assert.equal(blobs.reserved, 0);
  assert.equal((await blobs.status()).workspace.reservedBytes, 0);
  const later = await blobs.reserveTransient(80);
  later();
});

test("an archive upload does not consume a different working filesystem's reservation", async (t) => {
  const { blobs, archive } = await fixture(t);
  const bytes = Buffer.alloc(500, 7);
  const id = createHash("sha256").update(bytes).digest("hex");
  const stream = new PassThrough();
  const reading = once(stream, "resume", { signal: AbortSignal.timeout(5000) });
  const upload = blobs.put(id, stream, bytes.length);
  try {
    // Wait for the actual pipeline, not an arbitrary number of event-loop turns
    // that can elapse before a filesystem callback runs in a busy image build.
    await Promise.race([
      reading,
      upload.then(() => assert.fail("upload ended before its input started")),
    ]);
    assert.equal(blobs.active, 1);
    const release = await blobs.reserveTransient(50);
    assert.equal((await blobs.status()).workspace.reservedBytes, 50);
    release();
  } finally {
    stream.end(bytes);
    await upload;
  }
  assert.deepEqual(await readFile(join(archive, id)), bytes);
});

test("missing working filesystem telemetry rejects work without hiding readable archive capacity", async (t) => {
  const { blobs, setUnavailable } = await fixture(t);
  setUnavailable();
  await assert.rejects(blobs.reserveTransient(1), /storage_full/);
  const status = await blobs.status();
  assert.ok(status.availableBytes > 1000);
  assert.equal(status.workspace.state, "unavailable");
  assert.equal(status.workspace.freeBytes, null);
  assert.equal(status.workspace.availableBytes, 0);
  assert.equal(blobs.reserved, 0);
});

test("a separate sparse workspace also respects its actual native backing capacity", async (t) => {
  const { blobs } = await fixture(t, {
    free: 1000000,
    backing: { state: "fresh", availableBytes: 130, source: "wsl-vhd" },
  });
  await assert.rejects(blobs.reserveTransient(31), /storage_full/);
  const release = await blobs.reserveTransient(30);
  assert.equal((await blobs.status()).workspace.availableBytes, 0);
  release();
});

test("unavailable native workspace backing is conservative and releases failed reservations", async (t) => {
  const { blobs } = await fixture(t, {
    free: 1000000,
    backing: { state: "unavailable", source: "wsl-vhd", availableBytes: 0 },
  });
  await assert.rejects(blobs.reserveTransient(1), /storage_full/);
  assert.equal((await blobs.status()).workspace.availableBytes, 0);
  assert.equal(blobs.reserved, 0);
});

test("production reports its actual separate working filesystem through authenticated status", async (t) => {
  const shm = await stat("/dev/shm").catch(() => null);
  if (!shm?.isDirectory()) return t.skip("Linux tmpfs unavailable");
  const archive = await mkdtemp(join(tmpdir(), "haus-main-archive-"));
  const root = await mkdtemp("/dev/shm/haus-main-workspace-");
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await closed;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
    await rm(archive, { recursive: true, force: true });
  });
  if ((await stat(root)).dev === (await stat(archive)).dev)
    return t.skip("Separate filesystems required");
  await symlink(archive, join(root, "blobs"), "dir");
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const key = "workspace-status-fixture-key-not-production-32";
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../lib/main.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        HAUS_DATA: root,
        HAUS_NODE_KEY: key,
        HAUS_NODE_KEY_FILE: "",
        HAUS_ROLES: "storage",
        HAUS_SOURCE_ORIGIN: "",
        HAUS_HOST_TELEMETRY_FILE: "",
        PORT: String(port),
      },
      stdio: "ignore",
    },
  );
  let status;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null)
      throw Error("Fixture server exited before status");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: sign(key, "GET", "/v1/status"),
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        status = await response.json();
        break;
      }
    } catch {}
    await pause(100);
  }
  assert.ok(status, "Production status must become ready");
  assert.equal(status.storage.workspace.separateFilesystem, true);
  assert.equal(status.storage.workspace.state, "fresh");
  assert.ok(status.storage.workspace.freeBytes >= 0);
  assert.equal(status.storage.storageLimitBytes, null);
});

test("real separate Linux tmpfs capacity bounds reservation without allocating a large buffer", async (t) => {
  const shm = await stat("/dev/shm").catch(() => null);
  if (!shm?.isDirectory()) return t.skip("Linux tmpfs unavailable");
  const root = await mkdtemp(join(tmpdir(), "haus-real-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp("/dev/shm/haus-real-workspace-");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  if ((await stat(root)).dev === (await stat(workspace)).dev)
    return t.skip("A separate filesystem is required");
  const free = await statfs(workspace);
  const archive = await statfs(root);
  const request = free.bavail * free.bsize + 1;
  if (request > 16 * 1024 ** 3 || request >= archive.bavail * archive.bsize)
    return t.skip("Workspace is not smaller than the archive for this fixture");
  const blobs = new Blobs(join(root, "archive"), {
    workspaceRoot: workspace,
    reserveBytes: 0,
  });
  await blobs.initialize();
  await assert.rejects(blobs.reserveTransient(request), /storage_full/);
  assert.equal((await blobs.status()).workspace.separateFilesystem, true);
});

test("working admission recovers after capacity returns without retaining failed reservations", async (t) => {
  const { blobs, setFree } = await fixture(t, { free: 120 });
  await assert.rejects(blobs.reserveTransient(32), /storage_full/);
  setFree(260);
  const release = await blobs.reserveTransient(80);
  assert.equal((await blobs.status()).workspace.availableBytes, 80);
  release();
  assert.equal((await blobs.status()).workspace.reservedBytes, 0);
});
