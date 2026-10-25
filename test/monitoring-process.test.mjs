import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sign } from "../lib/auth.mjs";
import { fileURLToPath } from "node:url";

test(
  "the actual server process starts in monitoring mode without a media producer",
  { timeout: 25000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "haus-monitor-process-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const key = "monitoring-process-fixture-key-32-characters";
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../lib/main.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          HAUS_DATA: root,
          HAUS_NODE_ID: "monitoring-fixture",
          HAUS_NODE_KEY: key,
          HAUS_NODE_KEY_FILE: "",
          HAUS_ROLES: "",
          HAUS_SOURCE_ORIGIN: "",
          HAUS_HOST_TELEMETRY_FILE: "",
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const record = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
      await rm(root, { recursive: true, force: true });
    });
    let status;
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
          headers: sign(key, "GET", "/v1/status"),
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          status = await response.json();
          break;
        }
      } catch {}
      await delay(100);
    }
    assert.ok(status, "Monitoring process did not become ready: " + output);
    assert.equal(status.nodeId, "monitoring-fixture");
    assert.deepEqual(status.roles, []);
    assert.equal(status.streams.max, 0);
    assert.equal(status.media.max, 0);
    assert.equal(status.host.scope, "host");
    assert.ok(Number.isFinite(Date.parse(status.host.sampledAt)));
    assert.equal(status.rtspSessions, undefined);
    assert.equal(status.playback, undefined);
    assert.equal(status.detectors, undefined);
    const files = await readdir(root);
    assert.ok(
      !files.some((name) =>
        ["camera-runtime", "camera-sessions", "playback", "streams"].includes(
          name,
        ),
      ),
    );
  },
);
