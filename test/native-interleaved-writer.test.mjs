import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = process.env.CXX || "c++";

test("native RTSP writer completes partial TCP frames and bounds stalled readers", async (t) => {
  const available = spawnSync(compiler, ["--version"]);
  if (available.error?.code === "ENOENT") {
    t.skip("C++ compiler is unavailable");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "haus-interleaved-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "interleaved-writer-test");
  const compile = spawnSync(
    compiler,
    [
      "-std=c++17",
      "-pthread",
      "-I",
      join(root, "native/src"),
      join(root, "test/fixtures/interleaved-writer.cpp"),
      "-o",
      binary,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("native RTP sender spreads frame bursts and starts promptly after an idle interval", async (t) => {
  const available = spawnSync(compiler, ["--version"]);
  if (available.error?.code === "ENOENT") {
    t.skip("C++ compiler is unavailable");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "haus-rtp-pacer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "pacer-test");
  const compile = spawnSync(
    compiler,
    [
      "-std=c++17",
      "-pthread",
      "-I",
      join(root, "native/src"),
      join(root, "test/fixtures/rtp-pacer.cpp"),
      "-o",
      binary,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
