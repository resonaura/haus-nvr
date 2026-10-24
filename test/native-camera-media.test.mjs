import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { NativeCameraMedia } from "../lib/native-camera-media.mjs";

class FakeChild extends EventEmitter {
  constructor(write) {
    super();
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        write?.(chunk.toString());
        callback();
      },
    });
  }
  kill() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0));
  }
}

const emit = (child, value) => child.stdout.write(`${JSON.stringify(value)}\n`);

test("native RTSP producer stays warm while a browser viewer starts and closes", async (t) => {
  const nativeCommands = [],
    ffmpeg = [],
    logs = [];
  let native;
  const engine = new NativeCameraMedia("/unused", {
    binary: "haus-camera-media-test",
    log: (event, fields) => logs.push({ event, ...fields }),
    spawnProcess: (file, args) => {
      if (file === "haus-camera-media-test") {
        native = new FakeChild((text) => {
          for (const line of text.trim().split("\n")) {
            const command = JSON.parse(line);
            nativeCommands.push(command);
            if (command.cmd === "start_relay")
              queueMicrotask(() =>
                emit(native, { event: "relay_started", did: command.did }),
              );
            if (command.cmd === "reset_relay")
              queueMicrotask(() =>
                emit(native, { event: "relay_reset", did: command.did }),
              );
            if (command.cmd === "start_viewer")
              queueMicrotask(() => {
                emit(native, {
                  event: "viewer_offer",
                  viewer_id: command.viewer_id,
                  did: command.did,
                  rtp_port: 35001,
                  audio_rtp_port: 35002,
                  sdp: "v=0\r\na=candidate:1 1 udp 100 172.19.0.2 8555 typ host generation 0\r\n",
                });
              });
            if (command.cmd === "exit") queueMicrotask(() => native.kill());
          }
        });
        queueMicrotask(() => emit(native, { event: "ready" }));
        return native;
      }
      const child = new FakeChild();
      child.stderr = new PassThrough();
      ffmpeg.push({ file, args, child });
      queueMicrotask(() => {
        child.emit("spawn");
        if (ffmpeg.length === 1)
          emit(native, { event: "relay_ready", did: randomUUID() });
      });
      return child;
    },
    now: () => Date.now(),
  });
  t.after(() => engine.stop());
  await engine.initialize("192.168.1.8");
  const id = randomUUID();
  await engine.add(id, "rtsp://user:secret@192.168.1.15:8554/live", {
    sourceKind: "p2p-restream",
    cameraId: "camera.outdoor",
  });

  // The readiness event is tied to the actual session, like the native worker's
  // SPS/IDR and audio gate. The first synthetic event above uses another id.
  emit(native, { event: "relay_ready", did: id });
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === "source_media_ready" &&
        entry.cameraId === "camera.outdoor",
    ),
  );
  const result = await engine.offer(
    id,
    "fixture-owner-123456789",
    "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n",
  );

  assert.equal(
    ffmpeg.length,
    1,
    "the viewer reader must wait until ICE/DTLS is connected",
  );
  assert.equal(
    ffmpeg[0].args.includes("rtsp://user:secret@192.168.1.15:8554/live"),
    true,
  );
  assert.equal(result.viewerId.length, 36);
  assert.match(result.answer.sdp, /192\.168\.1\.8 8555 typ host/);
  assert.doesNotMatch(JSON.stringify(result), /secret|172\.19\.0\.2/);

  emit(native, {
    event: "viewer_state",
    viewer_id: result.viewerId,
    did: id,
    state: "connected",
  });
  const readerDeadline = Date.now() + 1000;
  while (ffmpeg.length < 2 && Date.now() < readerDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    ffmpeg.length,
    2,
    "a connected viewer should attach to the already warm relay",
  );
  assert.equal(ffmpeg[1].args.includes(engine.localRtsp(id)), true);

  const viewerClosed = once(ffmpeg[1].child, "close");
  engine.closeViewer(result.viewerId, "fixture-owner-123456789");
  await viewerClosed;
  assert.equal(ffmpeg[1].child.exitCode, 0);
  assert.equal(ffmpeg[0].child.exitCode, null);
  assert.equal(engine.sessions.has(id), true);
  const localUrl = engine.localRtsp(id);
  ffmpeg[0].child.stderr.write(
    "RTSP open failed for rtsp://user:secret@192.168.1.15:8554/live",
  );
  ffmpeg[0].child.exitCode = 1;
  ffmpeg[0].child.emit("close", 1);
  const restartDeadline = Date.now() + 3000;
  while (ffmpeg.length < 3 && Date.now() < restartDeadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    ffmpeg.length,
    3,
    "a dropped source reader should reconnect with backoff",
  );
  assert.equal(
    engine.localRtsp(id),
    localUrl,
    "source recovery should preserve the warmed RTSP relay address",
  );
  assert.equal(
    nativeCommands.some((command) => command.cmd === "reset_relay"),
    true,
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === "source_reader_closed" &&
        entry.cameraId === "camera.outdoor",
    ),
  );
  assert.ok(
    logs.some((entry) => entry.detail?.includes("[redacted RTSP URL]")),
  );
  assert.doesNotMatch(JSON.stringify(logs), /secret|192\.168\.1\.15/);
  const producerClosed = once(ffmpeg[2].child, "close");
  await engine.remove(id);
  await producerClosed;
  assert.equal(ffmpeg[2].child.exitCode, 0);
  assert.equal(
    nativeCommands.some((command) => command.cmd === "stop_relay"),
    true,
  );
});
