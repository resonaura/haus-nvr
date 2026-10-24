import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const binary = process.env.HAUS_CAMERA_MEDIA_BIN;

// No real camera, household source, or remote ICE endpoint is involved. The
// offer includes both recvonly tracks just as Chromium creates them in Haus.
function browserOffer() {
  return [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0 1",
    "a=msid-semantic: WMS *",
    ...["video", "audio"].flatMap((kind, index) => [
      `m=${kind} 9 UDP/TLS/RTP/SAVPF ${index ? 111 : 96}`,
      "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:fixture",
      "a=ice-pwd:fixturepassword012345678901",
      "a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F",
      "a=setup:actpass",
      `a=mid:${index}`,
      "a=recvonly",
      "a=rtcp-mux",
      `a=rtpmap:${index ? 111 : 96} ${index ? "opus/48000/2" : "H264/90000"}`,
      ...(index ? [] : ["a=fmtp:96 packetization-mode=1"]),
    ]),
    "",
  ].join("\r\n");
}

function nativeWorker() {
  const process = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const events = [];
  let pending = "";
  process.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) return;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  return {
    process,
    send(command) {
      process.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async waitFor(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) return event;
        if (process.exitCode !== null)
          throw new Error("native signaling worker exited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("native signaling response timed out");
    },
    async close() {
      if (process.exitCode !== null) return;
      const closed = once(process, "close");
      const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
      this.send({ cmd: "exit" });
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test(
  "native browser signaling repeatedly emits a DTLS answer for both media tracks",
  { skip: !binary, timeout: 30000 },
  async (t) => {
    const worker = nativeWorker();
    t.after(() => worker.close());
    await worker.waitFor((event) => event.event === "ready");
    const roles = [];
    for (let attempt = 0; attempt < 10; ++attempt) {
      const viewerId = randomUUID();
      worker.send({
        cmd: "start_viewer",
        viewer_id: viewerId,
        did: randomUUID(),
        sdp: browserOffer(),
      });
      const response = await worker.waitFor(
        (event) => event.viewer_id === viewerId,
      );
      assert.equal(response.event, "viewer_offer", "native viewer must answer");
      const sdp = response.sdp;
      assert.deepEqual(
        [...sdp.matchAll(/^a=mid:([^\r\n]+)/gm)].map((match) => match[1]),
        ["0", "1"],
        "answer must retain exactly the offered video and audio mids",
      );
      assert.equal(
        /^a=rtpmap:96 H264\/90000\r?$/m.test(sdp),
        true,
        "video must select the offered H264 payload type",
      );
      assert.equal(
        /^a=rtpmap:111 opus\/48000(?:\/2)?\r?$/im.test(sdp),
        true,
        "audio must select the offered Opus payload type",
      );
      const setup = [...sdp.matchAll(/^a=setup:([^\r\n]+)/gm)].map(
        (match) => match[1],
      );
      assert.ok(setup.length > 0, "answer must declare its DTLS role");
      roles.push(...setup);
      worker.send({ cmd: "stop_viewer", viewer_id: viewerId });
    }
    assert.equal(
      roles.every((role) => role === "active" || role === "passive"),
      true,
      `every emitted answer needs a fixed DTLS role; received ${JSON.stringify(roles)}`,
    );
  },
);
