import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackup } from "../../lib/recovery.mjs";
import { Blobs } from "../../lib/blobs.mjs";
import { RecordingIndex } from "../../lib/recording-index.mjs";
import { Catalog } from "../../lib/catalog.mjs";
import { createNode } from "../../lib/server.mjs";
const helper = process.env.HAUS_HELPER_PATH;
test(
  "three real nodes replicate encrypted configuration, distribute media, recover after disk replacement and serve scoped ranges",
  { skip: !helper },
  async (t) => {
    const { Store } = await import(
      pathToFileURL(join(helper, "lib/store.mjs"))
    );
    const { Backups, unseal } = await import(
      pathToFileURL(join(helper, "lib/backups.mjs"))
    );
    const { SharedConfig } = await import(
      pathToFileURL(join(helper, "lib/shared-config.mjs"))
    );
    const { Cluster } = await import(
      pathToFileURL(join(helper, "lib/cluster.mjs"))
    );
    const root = await mkdtemp(join(tmpdir(), "haus-cluster-integration-"));
    const media = join(root, "media");
    await mkdir(media);
    const store = new Store(join(root, "haus.sqlite"), media);
    const config = { data: root, standalone: true, ha_backups_enabled: false };
    const backups = new Backups(config, store);
    await backups.initialize();
    const shared = new SharedConfig(store);
    const cluster = new Cluster(store, backups);
    const fixtures = [];
    t.after(async () => {
      cluster.stop();
      await backups.stop();
      for (const node of fixtures) {
        node.server.closeAllConnections();
        await new Promise((r) => node.server.close(r));
      }
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    for (let i = 0; i < 3; i++) {
      const dir = join(root, "node" + i);
      const blobs = new Blobs(join(dir, "blobs"), {
        reserveBytes: 0,
        maxBytes: 10000000,
      });
      await blobs.initialize();
      const catalog = new Catalog(join(dir, "catalog.json"), blobs);
      await catalog.initialize();
      const key = "unique-test-node-key-for-fixture-" + i;
      const recordings = new RecordingIndex(
        join(dir, "recordings.sqlite"),
        blobs,
      );
      const server = createNode({
        key,
        blobs,
        catalog,
        recordings,
        nodeId: "node" + i,
        instanceId: randomUUID(),
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}`;
      await cluster.add({
        name: "Node " + i,
        url,
        key,
        roles: ["storage", "stream"],
        allowHttp: true,
      });
      fixtures.push({ server, url, dir, blobs, catalog, key });
    }
    shared.patch("0", {
      favorites: ["light.narnia"],
      roomIcons: { narnia: "moon" },
    });
    const snapshot = await backups.snapshot("haus");
    const event = store.create("camera.test", "motion", 1000, 3000);
    await writeFile(store.path(event.id), "0123456789");
    store.finish(event.id, { bytes: 10, duration: 2, playbackVersion: 2 });
    await cluster.tick();
    assert.equal(cluster.status().nodes.length, 3);
    assert.ok(cluster.status().nodes.every((node) => node.backupCopies === 1));
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM cluster_locations WHERE kind='media'",
        )
        .get().n,
      2,
    );
    for (const node of fixtures) {
      assert.equal(node.catalog.list().length, 1);
      const encrypted = await readFile(join(node.blobs.root, snapshot.digest));
      assert.ok(!encrypted.includes(Buffer.from("light.narnia")));
      assert.ok(!encrypted.includes(Buffer.from(node.key)));
    }
    const source = await cluster.source(store.get(event.id));
    assert.ok(source?.url);
    const range = await fetch(source.url, { headers: { Range: "bytes=3-6" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "3456");
    assert.ok(!source.url.includes(fixtures[0].key));
    const restored = join(root, "restored.tar.gz");
    await unseal(backups.path(snapshot.digest), restored, backups.key);
    assert.ok((await stat(restored)).size > 0);
    await decryptBackup(
      backups.path(snapshot.digest),
      join(root, "nvr-restored.tar.gz"),
      backups.key.toString("hex"),
    );
    assert.deepEqual(
      await readFile(restored),
      await readFile(join(root, "nvr-restored.tar.gz")),
    );
    const corrupted = Buffer.from(
      await readFile(backups.path(snapshot.digest)),
    );
    corrupted[corrupted.length - 20] ^= 1;
    const corruptPath = join(root, "corrupt.enc");
    await writeFile(corruptPath, corrupted);
    await assert.rejects(() =>
      unseal(corruptPath, join(root, "must-not-exist"), backups.key),
    );
    await assert.rejects(() => stat(join(root, "must-not-exist")));
    const kit = join(root, "recovery.json");
    await writeFile(
      kit,
      JSON.stringify({ ...backups.recoveryKit(), nodes: cluster.nodes() }),
      { mode: 0o600 },
    );
    const workerId = store.db
      .prepare(
        "SELECT node_id FROM cluster_locations WHERE kind='media' LIMIT 1",
      )
      .get().node_id;
    const runCli = (args) =>
      new Promise((resolve, reject) => {
        const process = spawn(
          globalThis.process.execPath,
          ["lib/recover.mjs", "--kit", kit, "--node", workerId, ...args],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        process.stdout.on("data", (data) => {
          output += data;
        });
        process.stderr.on("data", () => {});
        process.on("error", reject);
        process.on("close", (code) =>
          code === 0 ? resolve(output) : reject(new Error("CLI failed")),
        );
      });
    const exported = join(root, "cli-backup.tar");
    await runCli(["--digest", snapshot.digest, "--output", exported]);
    assert.deepEqual(await readFile(exported), await readFile(restored));
    const listing = JSON.parse(await runCli(["--list-recordings"]));
    assert.ok(listing.items.some((item) => item.id === event.id));
    const video = join(root, "cli-video.mp4");
    await runCli(["--recording", event.id, "--output", video]);
    assert.equal(await readFile(video, "utf8"), "0123456789");
    await assert.rejects(() =>
      runCli(["--recording", event.id, "--output", video]),
    );
    assert.equal(await readFile(video, "utf8"), "0123456789");
    // Replace one worker's disk while keeping its address/key. Instance identity invalidates stale acknowledgements.
    const first = fixtures[0],
      port = first.server.address().port;
    first.server.closeAllConnections();
    await new Promise((r) => first.server.close(r));
    await rm(first.dir, { recursive: true, force: true });
    const replacement = new Blobs(join(first.dir, "blobs"), {
      reserveBytes: 0,
      maxBytes: 10000000,
    });
    await replacement.initialize();
    const catalog = new Catalog(join(first.dir, "catalog.json"), replacement);
    await catalog.initialize();
    const recordings = new RecordingIndex(
      join(first.dir, "recordings.sqlite"),
      replacement,
    );
    first.server = createNode({
      key: first.key,
      blobs: replacement,
      catalog,
      recordings,
      nodeId: "node0",
      instanceId: randomUUID(),
    });
    await new Promise((r) => first.server.listen(port, "127.0.0.1", r));
    await cluster.tick();
    assert.equal(catalog.list().length, 1);
    assert.ok((await stat(join(replacement.root, snapshot.digest))).size > 0);
    assert.ok(cluster.status().nodes.every((node) => node.online));
    assert.ok(!JSON.stringify(cluster.status()).includes(first.key));
  },
);
