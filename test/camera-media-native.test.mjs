import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraRing } from "../lib/camera-ring.mjs";
import { NativeCameraMedia } from "../lib/native-camera-media.mjs";

const binary = process.env.HAUS_CAMERA_MEDIA_BIN;
const freeTcpPort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const freeUdpPort = async () => {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};

function nativeWorker() {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  let pending = "";
  const events = [];
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) return;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  return {
    child,
    events,
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    async waitFor(eventName, timeout = 5000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = events.find((event) => event.event === eventName);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`native event timeout: ${eventName}`);
    },
    async close() {
      if (child.exitCode !== null) return;
      this.send({ cmd: "exit" });
      await once(child, "close");
    },
  };
}

test(
  "Haus native media binary starts its loopback RTSP relay",
  { skip: !binary },
  async (t) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    t.after(() => {
      child.kill("SIGKILL");
    });
    const events = [];
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const index = pending.indexOf("\n");
        if (index < 0) return;
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });
    const waitFor = async (event, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = events.find((item) => item.event === event);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`native event timeout: ${event}`);
    };
    await waitFor("ready");
    const did = randomUUID();
    child.stdin.write(
      `${JSON.stringify({
        cmd: "start_relay",
        did,
        rtsp_port: await freeTcpPort(),
        rtp_port: await freeUdpPort(),
        audio_rtp_port: await freeUdpPort(),
        rtsp_path: did,
      })}\n`,
    );
    assert.equal((await waitFor("relay_started")).did, did);
    child.stdin.write('{"cmd":"exit"}\n');
    await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
  },
);

test(
  "prewarmed RTSP feeds an audio video pre-roll recording and native WebRTC answer",
  { skip: !binary },
  async (t) => {
    const source = nativeWorker();
    const directory = await mkdtemp(join(tmpdir(), "haus-native-camera-test-"));
    let generator, ring;
    const engine = new NativeCameraMedia(directory, { binary });
    t.after(async () => {
      await ring?.stop().catch(() => {});
      await engine.stop().catch(() => {});
      if (generator && generator.exitCode === null) {
        const closed = once(generator, "close");
        generator.kill("SIGKILL");
        await closed;
      }
      await source.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });

    await source.waitFor("ready");
    const sourceId = randomUUID(),
      sourcePort = await freeTcpPort(),
      sourceVideoPort = await freeUdpPort(),
      sourceAudioPort = await freeUdpPort();
    source.send({
      cmd: "start_relay",
      did: sourceId,
      rtsp_port: sourcePort,
      rtp_port: sourceVideoPort,
      audio_rtp_port: sourceAudioPort,
      rtsp_path: sourceId,
    });
    assert.equal((await source.waitFor("relay_started")).did, sourceId);

    generator = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=15",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=16000",
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "15",
        "-keyint_min",
        "15",
        "-sc_threshold",
        "0",
        "-bsf:v",
        "dump_extra=freq=keyframe",
        "-f",
        "rtp",
        "-payload_type",
        "96",
        `rtp://127.0.0.1:${sourceVideoPort}?pkt_size=1200`,
        "-map",
        "1:a:0",
        "-vn",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-b:a",
        "32k",
        "-f",
        "rtp",
        "-payload_type",
        "97",
        `rtp://127.0.0.1:${sourceAudioPort}?pkt_size=1200`,
      ],
      { stdio: "ignore" },
    );
    await once(generator, "spawn");

    await engine.initialize("192.168.1.20");
    const cameraId = randomUUID();
    await engine.add(cameraId, `rtsp://127.0.0.1:${sourcePort}/${sourceId}`);
    await Promise.race([
      engine.sessions.get(cameraId).readyPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("source prewarm timeout")), 15000),
      ),
    ]);

    ring = new CameraRing(join(directory, "ring"), engine.localRtsp(cameraId), {
      requireAudio: true,
      recordAudio: true,
      retentionSeconds: 24,
    });
    await ring.start();
    const warmDeadline = Date.now() + 15000;
    while (!ring.ready() && Date.now() < warmDeadline) {
      await ring.sample();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert.equal(
      ring.ready(),
      true,
      "RTSP video and AAC audio should be warm before the viewer opens",
    );
    await new Promise((resolve) => setTimeout(resolve, 2600));

    const eventStart = Date.now();
    const job = await ring.record({
      eventId: randomUUID(),
      startAt: eventStart - 1800,
      endAt: eventStart + 1800,
    });

    const offerStartedAt = Date.now();
    const answer = await engine.offer(
      cameraId,
      "fixture-owner-123456789",
      [
        "v=0",
        "o=- 1 1 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0 1",
        "a=msid-semantic: WMS *",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:fixture",
        "a=ice-pwd:fixturepassword012345678901",
        "a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F",
        "a=setup:actpass",
        "a=mid:0",
        "a=recvonly",
        "a=rtcp-mux",
        "a=rtpmap:96 H264/90000",
        "a=fmtp:96 packetization-mode=1",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:fixture",
        "a=ice-pwd:fixturepassword012345678901",
        "a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F",
        "a=setup:actpass",
        "a=mid:1",
        "a=recvonly",
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        "",
      ].join("\r\n"),
    );
    assert.ok(
      Date.now() - offerStartedAt < 5000,
      "an already prewarmed camera should not wait for a new source startup",
    );
    assert.equal(answer.answer.type, "answer");
    assert.match(answer.answer.sdp, /H264\/90000/);
    assert.match(answer.answer.sdp, /opus\/48000/i);
    assert.match(answer.answer.sdp, /a=setup:(active|passive)\r?$/m);
    assert.doesNotMatch(answer.answer.sdp, /a=setup:actpass/);
    assert.equal(engine.viewers.size, 1);
    engine.closeViewer(answer.viewerId, "fixture-owner-123456789");
    assert.equal(
      engine.sessions.has(cameraId),
      true,
      "closing the viewer must leave the warmed RTSP producer alive",
    );

    const jobId = job.id,
      recordingDeadline = Date.now() + 20000;
    while (
      ["recording", "preparing"].includes(ring.jobs.get(jobId)?.state) &&
      Date.now() < recordingDeadline
    ) {
      await ring.sample();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const finished = ring.jobs.get(jobId);
    assert.equal(
      finished?.state,
      "ready",
      finished?.error ?? "pre-roll recording did not finalize",
    );
    assert.equal(finished.result.audio, true);
    assert.ok(finished.result.duration >= 3);
    assert.ok(
      finished.result.mediaStartAt <= eventStart + 1000,
      "recording should include video before the event",
    );
  },
);
