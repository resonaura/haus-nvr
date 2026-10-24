import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { Blobs } from "../lib/blobs.mjs";
import {
  StorageBacking,
  sanitizeStorageBacking,
  wslStorageBacking,
} from "../lib/wsl-storage.mjs";
import { sanitizeHostReport } from "../lib/host-telemetry.mjs";

const backing = (at = 10000, changes = {}) => ({
  source: "wsl-vhd",
  device: 2112,
  sampledAt: new Date(at).toISOString(),
  totalBytes: 256000,
  availableBytes: 62000,
  volume: "C:",
  ...changes,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("WSL resolves only its exact distribution/VHD and hosting volume with bounded read-only queries", async () => {
  const calls = [];
  const value = await wslStorageBacking({
    now: () => 10000,
    inspect: async (path) => {
      assert.equal(path, "/");
      return { dev: 2112 };
    },
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === "/usr/bin/wslpath") return "\\\\wsl.localhost\\Ubuntu\\\n";
      return JSON.stringify({
        AvailableBytes: 62000,
        TotalBytes: 256000,
        Volume: "C:",
      });
    },
  });
  assert.deepEqual(value, backing());
  assert.equal(calls[1].options.timeout, 8000);
  assert.equal(calls[1].options.maxBuffer, 16384);
  const script = Buffer.from(calls[1].args.at(-1), "base64").toString(
    "utf16le",
  );
  assert.match(script, /GetValue\('DistributionName'\) -ceq \$name/);
  assert.match(script, /Get-Volume -FilePath \$file/);
  assert.match(script, /\$base\.StartsWith/);
  assert.doesNotMatch(script, /-replace/);
  assert.match(script, /Test-Path -LiteralPath \$file -PathType Leaf/);
  assert.doesNotMatch(script, /Set-|Remove-|Resize-|Invoke-|Format-/);
  assert.ok(!JSON.stringify(value).includes("BasePath"));
  await assert.rejects(
    wslStorageBacking({ run: async () => "C:\\wrong" }),
    /wsl_distribution_unknown/,
  );
});

test("backing capacity validates timestamps, byte counts and volume labels instead of leaking image paths", () => {
  assert.equal(
    sanitizeStorageBacking(backing(10000, { secret: "path" }), 10000).secret,
    undefined,
  );
  for (const change of [
    { device: -1 },
    { device: "2112" },
    { totalBytes: null },
    { availableBytes: 256001 },
    { availableBytes: -1 },
    { availableBytes: NaN },
    { sampledAt: new Date(41001).toISOString() },
    { sampledAt: new Date(8999).toISOString() },
  ])
    assert.throws(
      () => sanitizeStorageBacking(backing(10000, change), 40000),
      /invalid_storage_backing/,
    );
  assert.equal(
    sanitizeStorageBacking(
      backing(10000, { volume: "private file path" }),
      10000,
    ).volume,
    "Windows volume",
  );
});

test("admission binds the data mount to its device, requires a post-start sample and never revives stale sparse capacity", async () => {
  let at = 10000,
    dev = 2112,
    report;
  const guard = new StorageBacking("/data/blobs", () => report, {
    now: () => at,
    inspect: async () => ({ dev }),
    required: true,
  });
  assert.equal((await guard.capacity()).state, "unavailable");
  report = { storageBacking: backing(9999) };
  assert.equal((await guard.capacity()).state, "unavailable");
  report.storageBacking = backing();
  assert.equal((await guard.capacity()).availableBytes, 62000);
  at = 10010;
  report.storageBacking = backing(10010, {
    volume: "D:",
    availableBytes: 40000,
  });
  assert.equal((await guard.capacity()).volume, "D:");
  report.storageBacking = backing(10000);
  assert.equal((await guard.capacity()).state, "unavailable");
  report.storageBacking = backing(10010);
  dev = 3000;
  assert.equal((await guard.capacity()).state, "unavailable");
  dev = 2112;
  at = 40011;
  assert.equal((await guard.capacity()).state, "unavailable");
  report.storageBacking = backing(at);
  assert.equal((await guard.capacity()).state, "fresh");
  report = null;
  assert.equal((await guard.capacity()).state, "unavailable");
  const ordinary = new StorageBacking("/data", () => null, {
    inspect: async () => ({ dev: 1 }),
  });
  assert.equal(await ordinary.capacity(), null);
});

test("native capacity bounds unlimited writes, concurrent reservations and repeated stale-sample growth without changing originals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-wsl-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let at = 10000;
  let capacity = { ...backing(at), state: "fresh", availableBytes: 1000 };
  const blobs = new Blobs(root, {
    now: () => at,
    reserveBytes: 100,
    backingCapacity: async () => capacity,
    filesystem: async () => ({ bavail: 1000000, bsize: 1, blocks: 2000000 }),
  });
  await blobs.initialize();
  assert.equal((await blobs.status()).availableBytes, 900);
  assert.equal((await blobs.status()).storageLimitBytes, null);
  const original = Buffer.alloc(400, 1);
  await blobs.put(digest(original), Readable.from(original), original.length);
  assert.equal((await blobs.status()).availableBytes, 500);
  // A duplicate digest consumes no additional physical growth.
  await blobs.put(digest(original), Readable.from(original), original.length);
  assert.equal((await blobs.status()).availableBytes, 500);
  const release = await blobs.reserveTransient(400);
  await assert.rejects(blobs.reserveTransient(101), /storage_full/);
  release();
  const other = Buffer.alloc(400, 2);
  await blobs.put(digest(other), Readable.from(other), other.length);
  assert.equal((await blobs.status()).availableBytes, 100);
  const refused = Buffer.alloc(101, 3);
  await assert.rejects(
    blobs.put(digest(refused), Readable.from(refused), refused.length),
    /storage_full/,
  );
  assert.equal(blobs.reserved, 0);
  assert.equal(blobs.active, 0);
  assert.deepEqual(
    (await readdir(root)).sort(),
    [digest(original), digest(other)].sort(),
  );
  capacity = { state: "unavailable", source: "wsl-vhd", availableBytes: 0 };
  assert.equal((await blobs.status()).availableBytes, 0);
  await assert.rejects(blobs.reserveTransient(1), /storage_full/);
  assert.deepEqual(await readFile(join(root, digest(original))), original);
  at = 12000;
  capacity = { ...backing(at), state: "fresh", availableBytes: 200 };
  assert.equal((await blobs.status()).availableBytes, 100);
  blobs.setLimit(800);
  assert.equal((await blobs.status()).availableBytes, 0);
  blobs.setLimit(null);
  assert.equal((await blobs.status()).availableBytes, 100);
  assert.equal(blobs.growth.size, 1);
  at = 45000;
  await blobs.status();
  assert.equal(blobs.growth.size, 0);
});

test("host sanitizer whitelists the backing mapping and discards invalid/stale readings", () => {
  const host = {
    sampledAt: new Date(10000).toISOString(),
    scope: "host",
    cpu: { logicalCores: 4 },
    memory: { totalBytes: 1000, usedBytes: 500, availableBytes: 500 },
    storageBacking: { ...backing(), imagePath: "secret" },
  };
  const clean = sanitizeHostReport(host, 10000);
  assert.deepEqual(clean.storageBacking, backing());
  assert.ok(!JSON.stringify(clean).includes("secret"));
  assert.equal(
    sanitizeHostReport({ ...host, storageBacking: backing(-30000) }, 10000)
      .storageBacking,
    undefined,
  );
});
