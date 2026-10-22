import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Playback } from "../../lib/playback.mjs";
import { Blobs } from "../../lib/blobs.mjs";
import { RecordingIndex } from "../../lib/recording-index.mjs";
import { createNode } from "../../lib/server.mjs";

const helper = process.env.HAUS_HELPER_PATH;
test(
  "real helper offloads playback over authenticated HTTP, preserves audio/originals, and falls back for weak or disconnected nodes",
  { skip: !helper },
  async (t) => {
    const load = (file) => import(pathToFileURL(join(helper, "lib", file)));
    const { Store } = await load("store.mjs");
    const { Recorder } = await load("recorder.mjs");
    const { Cluster } = await load("cluster.mjs");
    const { runMedia } = await load("media.mjs");
    const { defaults } = await load("config.mjs");
    const root = await mkdtemp(join(tmpdir(), "haus-playback-integration-"));
    const media = join(root, "media");
    await mkdir(media);
    const store = new Store(join(root, "helper.sqlite"), media);
    const cluster = new Cluster(store, { list: () => [], markChanged() {} });
    const recorder = new Recorder(
      { ...defaults, data: root, media },
      {},
      store,
      undefined,
      {
        prepareRemote: (event, options) =>
          cluster.preparePlayback(event, options),
      },
    );
    const blobs = new Blobs(join(root, "blobs"), {
      maxBytes: 32 * 1024 ** 2,
      reserveBytes: 0,
    });
    await blobs.initialize();
    const capacity = {
      cpus: 2,
      memory: 1024 ** 3,
      memoryUsed: 64 * 1024 ** 2,
      pressured: false,
      status() {
        return {
          cpus: this.cpus,
          memoryBytes: this.memory,
          memoryUsedBytes: this.memoryUsed,
          cpu: 0.1,
          pressured: false,
        };
      },
    };
    const playback = new Playback(join(root, "work"), blobs, capacity, {
      maxBytes: 4 * 1024 ** 2,
    });
    await playback.initialize();
    const recordings = new RecordingIndex(
      join(root, "recordings.sqlite"),
      blobs,
    );
    const server = createNode({
      key: "fixture-private-node-key-at-least-32-characters",
      blobs,
      playback,
      recordings,
      capacity,
      nodeId: "fixture-worker",
      instanceId: randomUUID(),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let closed = false;
    t.after(async () => {
      await recorder.stop();
      await cluster.stop();
      await playback.stop();
      if (!closed) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      store.close();
      if (process.env.HAUS_KEEP_PLAYBACK_FIXTURE !== "1")
        await rm(root, { recursive: true, force: true });
    });
    await cluster.add({
      name: "fixture",
      url: `http://127.0.0.1:${server.address().port}`,
      allowHttp: true,
      key: "fixture-private-node-key-at-least-32-characters",
      roles: ["storage", "stream"],
    });
    const node = cluster.nodes()[0];
    const input = join(root, "source.mp4");
    await runMedia("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      input,
    ]);
    const original = await readFile(input),
      digest = createHash("sha256").update(original).digest("hex");
    let localEncoders = 0;
    const local = recorder.encoding.run.bind(recorder.encoding);
    recorder.encoding.run = (...args) => {
      localEncoders++;
      return local(...args);
    };
    const reports = [];
    for (const mode of ["remote", "weak", "offline"]) {
      if (mode === "weak") {
        capacity.cpus = 0.75;
        capacity.memory = 512 * 1024 ** 2;
        await cluster.poll();
      }
      if (mode === "offline") {
        capacity.cpus = 2;
        capacity.memory = 1024 ** 3;
        await cluster.poll();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        closed = true;
      }
      const event = store.create("camera.fixture", "manual", 1000, 4000);
      await writeFile(store.path(event.id), original);
      store.finish(event.id, {
        bytes: original.length,
        duration: 3,
        playbackVersion: 0,
      });
      if (mode === "remote") {
        // Use production replication, including its real catalog kind; a
        // hand-written location can mask a client/server contract mismatch.
        await cluster.tick();
        const replica = store.db
          .prepare(
            "SELECT kind,catalog_version FROM cluster_locations WHERE digest=? AND node_id=?",
          )
          .get(digest, node.id);
        assert.equal(replica?.kind, "media");
        assert.equal(replica?.catalog_version, 1);
      }
      const before = localEncoders,
        began = performance.now();
      const output = await recorder.preparePlayback(store.get(event.id));
      assert.equal(localEncoders - before, mode === "remote" ? 0 : 1);
      const updated = store.get(event.id);
      assert.equal(updated.playbackVersion, 4);
      assert.equal(updated.playbackInfo.audio, true);
      await runMedia("ffmpeg", [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        output,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-fps_mode",
        "passthrough",
        "-enc_time_base:v",
        "1:90000",
        "-f",
        "null",
        "-",
      ]);
      assert.deepEqual(await readFile(store.path(event.id)), original);
      assert.equal(playback.jobs.size, 0);
      assert.equal(blobs.reserved, 0);
      assert.equal(capacity.playbackBusy, false);
      assert.deepEqual(await readdir(join(root, "work")), []);
      reports.push({
        mode,
        elapsedMs: Math.round(performance.now() - began),
        audio: true,
        output,
        originalPreserved: true,
      });
    }
    if (process.env.HAUS_PLAYBACK_REPORT)
      await writeFile(
        process.env.HAUS_PLAYBACK_REPORT,
        JSON.stringify({ root, reports }),
        { mode: 0o600 },
      );
    console.log(
      JSON.stringify({
        modes: reports.map(({ output, ...report }) => report),
        temporaryWorkReclaimed: true,
      }),
    );
  },
);
