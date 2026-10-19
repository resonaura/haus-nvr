import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerStreams } from "../lib/streams.mjs";
import { createNode } from "../lib/server.mjs";
import { Blobs } from "../lib/blobs.mjs";
import { sign } from "../lib/auth.mjs";
import { createHash } from "node:crypto";
test("a real FFmpeg relay serves live HLS, scopes its source, and releases encoder/files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-relay-")),
    input = join(root, "input");
  await mkdir(input);
  const source = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=20",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "20",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "5",
      "-hls_flags",
      "delete_segments",
      "-hls_segment_filename",
      join(input, "source-%09d.ts"),
      join(input, "index.m3u8"),
    ],
    { stdio: "ignore" },
  );
  const gate = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, "http://fixture").pathname
        .split("/")
        .at(-1);
      if (!/^(manifest|source-\d+\.ts)$/.test(name))
        return res.writeHead(403).end();
      res
        .writeHead(200, {
          "Content-Type":
            name === "manifest"
              ? "application/vnd.apple.mpegurl"
              : "video/mp2t",
        })
        .end(
          await readFile(
            join(input, name === "manifest" ? "index.m3u8" : name),
          ),
        );
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => gate.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${gate.address().port}`,
    streams = new WorkerStreams(join(root, "jobs"), origin);
  await streams.initialize();
  const blobs = new Blobs(join(root, "blobs"), { reserveBytes: 0 });
  await blobs.initialize();
  const key = "fixture-only-unique-secret-key-32bytes";
  const server = createNode({
    key,
    blobs,
    streams,
    nodeId: "relay",
    instanceId: "fixture",
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await streams.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    gate.closeAllConnections();
    await new Promise((r) => gate.close(r));
    source.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(() =>
    streams.start(
      "http://external.example/cluster/source/" + "a".repeat(48) + "/manifest",
    ),
  );
  const until = Date.now() + 8000;
  while (!(await stat(join(input, "index.m3u8")).catch(() => null))) {
    assert.ok(Date.now() < until, "source fixture startup");
    await new Promise((r) => setTimeout(r, 100));
  }
  const path = "/v1/streams",
    body = JSON.stringify({
      source: origin + "/cluster/source/" + "a".repeat(48) + "/manifest",
    }),
    digest = createHash("sha256").update(body).digest("hex");
  const started = await fetch(base + path, {
    method: "POST",
    headers: sign(key, "POST", path, digest),
    body,
  });
  assert.equal(started.status, 201);
  const job = await started.json();
  const playlistPath = `/v1/streams/${job.id}/index.m3u8`,
    playlist = await (
      await fetch(base + playlistPath, {
        headers: sign(key, "GET", playlistPath),
      })
    ).text();
  assert.ok(playlist.startsWith("#EXTM3U"));
  const segment = playlist.split("\n").find((line) => line.endsWith(".ts"));
  assert.ok(segment);
  const segmentPath = `/v1/streams/${job.id}/${segment}`;
  const bytes = await (
    await fetch(base + segmentPath, { headers: sign(key, "GET", segmentPath) })
  ).arrayBuffer();
  assert.ok(bytes.byteLength > 1000);
  assert.equal(streams.size, 1);
  const stopPath = `/v1/streams/${job.id}`;
  assert.equal(
    (
      await fetch(base + stopPath, {
        method: "DELETE",
        headers: sign(key, "DELETE", stopPath),
      })
    ).status,
    200,
  );
  assert.equal(streams.size, 0);
  await assert.rejects(() => stat(join(root, "jobs", job.id)));
});

test("stopping a relay during startup cannot spawn an orphan encoder", async () => {
  const root = await mkdtemp(join(tmpdir(), "haus-relay-cancel-"));
  let spawned = 0;
  const streams = new WorkerStreams(root, "http://127.0.0.1:9999", {
    spawnProcess: () => {
      spawned++;
      throw new Error("unexpected encoder");
    },
  });
  try {
    await streams.initialize();
    const pending = streams.start(
      "http://127.0.0.1:9999/cluster/source/" + "a".repeat(48) + "/manifest",
    );
    const rejected = assert.rejects(pending, /stream_stopped/);
    await streams.stop();
    await rejected;
    assert.equal(spawned, 0);
    assert.equal(streams.size, 0);
  } finally {
    await streams.stop();
    await rm(root, { recursive: true, force: true });
  }
});
