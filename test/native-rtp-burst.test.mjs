import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const binary = process.env.HAUS_CAMERA_MEDIA_BIN;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(udp = false) {
  const socket = udp ? dgram.createSocket("udp4") : createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    if (udp) socket.bind(0, "127.0.0.1", resolve);
    else socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function waitUntil(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(
    predicate(),
    typeof description === "function" ? description() : description,
  );
}

function worker() {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const events = [];
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      events.push(JSON.parse(line));
    }
  });
  return {
    child,
    send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async event(name) {
      await waitUntil(
        () => events.some((event) => event.event === name),
        `native event: ${name}`,
      );
      return events.find((event) => event.event === name);
    },
  };
}

// Read RTSP responses and binary RTP interleaved on the same TCP connection.
// The relay normalizes RTP headers, so payload equality and fragment order are
// checked separately from the outgoing sequence/timestamp continuity.
async function rtspReader(port, path) {
  const socket = createConnection({ port, host: "127.0.0.1" });
  const packets = [],
    audioPackets = [],
    responses = [];
  let pending = Buffer.alloc(0),
    cseq = 0;
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (!pending.length) return;
      if (pending[0] === 0x24) {
        if (pending.length < 4) return;
        const length = pending.readUInt16BE(2);
        if (pending.length < length + 4) return;
        if (pending[1] === 0)
          packets.push(Buffer.from(pending.subarray(4, length + 4)));
        if (pending[1] === 2)
          audioPackets.push(Buffer.from(pending.subarray(4, length + 4)));
        pending = pending.subarray(length + 4);
      } else {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = pending.subarray(0, end + 4).toString();
        const bodyLength = Number(
          header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0,
        );
        if (pending.length < end + 4 + bodyLength) return;
        responses.push(header);
        pending = pending.subarray(end + 4 + bodyLength);
      }
    }
  });
  await once(socket, "connect");
  return {
    socket,
    packets,
    audioPackets,
    async request(method, suffix = "", headers = "") {
      const sequence = ++cseq;
      socket.write(
        `${method} rtsp://127.0.0.1:${port}/${path}${suffix} RTSP/1.0\r\nCSeq: ${sequence}\r\n${headers}\r\n`,
      );
      await waitUntil(
        () =>
          responses.some((response) =>
            response.includes(`CSeq: ${sequence}\r\n`),
          ),
        `${method} response`,
      );
      const response = responses.find((item) =>
        item.includes(`CSeq: ${sequence}\r\n`),
      );
      assert.match(response, /^RTSP\/1\.0 200 OK/);
    },
  };
}

function rtp(payload, sequence, timestamp, marker = true) {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 96 | (marker ? 0x80 : 0);
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(0x10203040, 8);
  payload.copy(packet, 12);
  return packet;
}

function fragmentedFrame(nalType, count, sequence, timestamp) {
  return Array.from({ length: count }, (_, fragment) => {
    const payload = Buffer.alloc(1188);
    payload[0] = 0x7c; // H.264 FU-A, NRI=3.
    payload[1] =
      nalType |
      (fragment === 0 ? 0x80 : 0) |
      (fragment === count - 1 ? 0x40 : 0);
    payload.writeUInt32BE(sequence + fragment, 2);
    for (let offset = 6; offset < payload.length; offset++)
      payload[offset] = (sequence + fragment + offset) & 0xff;
    return rtp(payload, sequence + fragment, timestamp, fragment === count - 1);
  });
}

async function availableReceiveBuffer() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  try {
    for (let bytes = 8 * 1024 * 1024; bytes >= 256 * 1024; bytes /= 2) {
      try {
        socket.setRecvBufferSize(bytes);
        break;
      } catch {}
    }
    return socket.getRecvBufferSize();
  } finally {
    socket.close();
  }
}

test(
  "native RTSP preserves every large H.264 IDR and P-frame RTP fragment across a receive burst",
  {
    skip: !binary || process.platform === "win32",
    timeout: 15000,
  },
  async (t) => {
    const receiveBuffer = await availableReceiveBuffer();
    if (receiveBuffer < 4 * 1024 * 1024) {
      t.skip(
        `host limits SO_RCVBUF to ${receiveBuffer} bytes; this burst test requires 4 MiB including UDP packet overhead`,
      );
      return;
    }
    const source = worker();
    const sender = dgram.createSocket("udp4");
    let reader;
    t.after(async () => {
      // Always unstop the worker, including assertion/UDP-send failures.
      source.child.kill("SIGCONT");
      reader?.socket.destroy();
      sender.close();
      if (source.child.exitCode === null) {
        const closed = once(source.child, "close");
        source.child.kill("SIGKILL");
        await closed;
      }
    });
    await source.event("ready");
    const rtspPort = await freePort(),
      videoPort = await freePort(true),
      audioPort = await freePort(true);
    const did = randomUUID();
    source.send({
      cmd: "start_relay",
      did,
      rtsp_port: rtspPort,
      rtp_port: videoPort,
      audio_rtp_port: audioPort,
      rtsp_path: did,
    });
    await source.event("relay_started");
    reader = await rtspReader(rtspPort, did);
    await reader.request(
      "SETUP",
      "/track0",
      "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n",
    );
    await reader.request("PLAY");

    const send = (packet) =>
      new Promise((resolve, reject) =>
        sender.send(packet, videoPort, "127.0.0.1", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    const initial = [
      rtp(Buffer.from([0x67, 0x42, 0, 0x28]), 0, 0),
      rtp(Buffer.from([0x68, 0xce, 6]), 1, 0),
      rtp(Buffer.from([0x65, 0x88, 0x84]), 2, 0),
    ];
    for (const packet of initial) await send(packet);
    await waitUntil(
      () => reader.packets.length === initial.length,
      "initial keyframe reached the RTSP reader",
    );

    // A short scheduler stall makes the receive-buffer regression deterministic,
    // independent of the CI machine's speed. This 1.8 MiB burst models a detailed
    // large camera IDR followed by dependent frames; it fits the configured buffer.
    // The pre-fix macOS worker delivered only 642–643 of the 1539 RTP packets.
    const burst = fragmentedFrame(5, 512, 3, 9000);
    for (let frame = 0; frame < 32; frame++)
      burst.push(
        ...fragmentedFrame(1, 32, 515 + frame * 32, 18000 + frame * 6000),
      );
    source.child.kill("SIGSTOP");
    await delay(25);
    try {
      for (const packet of burst) await send(packet);
    } finally {
      source.child.kill("SIGCONT");
    }
    const expected = [...initial, ...burst];
    await waitUntil(
      () => reader.packets.length >= expected.length,
      () =>
        `all ${expected.length} RTP fragments survived the UDP receive burst (received ${reader.packets.length})`,
    );
    assert.equal(
      reader.packets.length,
      expected.length,
      "no RTP fragments were duplicated",
    );
    for (let index = 0; index < expected.length; index++) {
      const actual = reader.packets[index];
      assert.deepEqual(
        actual.subarray(12),
        expected[index].subarray(12),
        `RTP payload preserved at fragment ${index}`,
      );
      assert.equal(
        actual[1],
        expected[index][1],
        `RTP payload type and frame marker preserved at fragment ${index}`,
      );
      assert.equal(
        actual.readUInt16BE(2),
        index,
        `outgoing RTP sequence is contiguous at fragment ${index}`,
      );
      if (index > 0) {
        assert.equal(
          (actual.readUInt32BE(4) -
            reader.packets[index - 1].readUInt32BE(4)) >>>
            0,
          (expected[index].readUInt32BE(4) -
            expected[index - 1].readUInt32BE(4)) >>>
            0,
          `source video RTP clock preserved at fragment ${index}, including frames received in one burst`,
        );
      }
    }
  },
);

test(
  "native RTSP preserves the AAC media clock through a burst and RTP timestamp wraparound",
  { skip: !binary, timeout: 10000 },
  async (t) => {
    const source = worker();
    const sender = dgram.createSocket("udp4");
    let reader;
    t.after(async () => {
      reader?.socket.destroy();
      sender.close();
      if (source.child.exitCode === null) {
        const closed = once(source.child, "close");
        source.child.kill("SIGKILL");
        await closed;
      }
    });
    await source.event("ready");
    const rtspPort = await freePort(),
      videoPort = await freePort(true),
      audioPort = await freePort(true);
    const did = randomUUID();
    source.send({
      cmd: "start_relay",
      did,
      rtsp_port: rtspPort,
      rtp_port: videoPort,
      audio_rtp_port: audioPort,
      rtsp_path: did,
    });
    await source.event("relay_started");
    reader = await rtspReader(rtspPort, did);
    await reader.request(
      "SETUP",
      "/track1",
      "Transport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n",
    );
    await reader.request("PLAY");
    // Each AAC access unit is 1024 samples at the advertised 16 kHz clock.
    // The first increment wraps the source RTP clock. Arrival-time timestamps
    // collapse these 2 seconds of buffered audio to only a few ticks.
    const expected = Array.from({ length: 32 }, (_, index) => {
      const payload = Buffer.alloc(36, index);
      payload.writeUInt16BE(16, 0); // AU-headers-length in bits.
      payload.writeUInt16BE(32 << 3, 2); // 32-byte AAC AU, index zero.
      const packet = rtp(
        payload,
        300 + index,
        (0xffffff00 + index * 1024) >>> 0,
      );
      packet[1] = 0x80 | 97;
      return packet;
    });
    for (const packet of expected) {
      await new Promise((resolve, reject) =>
        sender.send(packet, audioPort, "127.0.0.1", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    await waitUntil(
      () => reader.audioPackets.length >= expected.length,
      "all AAC access units should reach the RTSP reader",
    );
    assert.ok(
      reader.audioPackets.every((packet) => (packet[1] & 0x7f) === 97),
      "an AAC RTSP track must not inject PCMU silence with an unadvertised payload type",
    );
    assert.equal(reader.audioPackets.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
      const actual = reader.audioPackets[index];
      assert.deepEqual(
        actual.subarray(12),
        expected[index].subarray(12),
        `AAC payload preserved at access unit ${index}`,
      );
      assert.equal(
        actual[1],
        expected[index][1],
        `AAC payload type and marker preserved at access unit ${index}`,
      );
      assert.equal(
        actual.readUInt16BE(2),
        index,
        `outgoing AAC sequence is contiguous at access unit ${index}`,
      );
      if (index > 0) {
        assert.equal(
          (actual.readUInt32BE(4) -
            reader.audioPackets[index - 1].readUInt32BE(4)) >>>
            0,
          1024,
          `AAC source sample clock preserved at access unit ${index}`,
        );
      }
    }
  },
);

test(
  "late RTSP readers display a cached still and wait for a clean live IDR before dependent frames",
  {
    skip: !binary,
    timeout: 10000,
  },
  async (t) => {
    const source = worker();
    const sender = dgram.createSocket("udp4");
    let reader;
    t.after(async () => {
      reader?.socket.destroy();
      sender.close();
      if (source.child.exitCode === null) {
        const closed = once(source.child, "close");
        source.child.kill("SIGKILL");
        await closed;
      }
    });
    await source.event("ready");
    const rtspPort = await freePort(),
      videoPort = await freePort(true),
      audioPort = await freePort(true);
    const did = randomUUID();
    source.send({
      cmd: "start_relay",
      did,
      rtsp_port: rtspPort,
      rtp_port: videoPort,
      audio_rtp_port: audioPort,
      rtsp_path: did,
    });
    await source.event("relay_started");
    const send = (packet) =>
      new Promise((resolve, reject) =>
        sender.send(packet, videoPort, "127.0.0.1", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    const cached = [
      rtp(Buffer.from([0x67, 0x42, 0, 0x28]), 0, 0),
      rtp(Buffer.from([0x68, 0xce, 6]), 1, 0),
      rtp(Buffer.from([0x65, 0x88, 0x84]), 2, 0),
    ];
    for (const packet of cached) await send(packet);
    // P1 and P2 advance the camera prediction chain before the reader joins.
    await send(rtp(Buffer.from([0x41, 1]), 3, 6000));
    await send(rtp(Buffer.from([0x41, 2]), 4, 12000));
    await delay(50);
    reader = await rtspReader(rtspPort, did);
    await reader.request(
      "SETUP",
      "/track0",
      "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n",
    );
    await reader.request("PLAY");
    await waitUntil(
      () => reader.packets.length >= cached.length,
      "cached IDR should immediately prime the late reader",
    );
    assert.equal(reader.packets.length, cached.length);
    for (let index = 0; index < cached.length; index++)
      assert.deepEqual(
        reader.packets[index].subarray(12),
        cached[index].subarray(12),
      );

    await send(rtp(Buffer.from([0x41, 3]), 5, 18000));
    // Joining in the middle of a fresh fragmented IDR must not unlock P-frames.
    const incomplete = fragmentedFrame(5, 3, 6, 24000);
    await send(incomplete[1]);
    await send(incomplete[2]);
    await send(rtp(Buffer.from([0x41, 4]), 9, 30000));
    await delay(100);
    assert.equal(
      reader.packets.length,
      cached.length,
      "P-frames and orphan IDR fragments must wait for a complete clean IDR start",
    );

    const fresh = fragmentedFrame(5, 3, 10, 36000);
    for (const packet of fresh) await send(packet);
    const dependent = rtp(Buffer.from([0x41, 5]), 13, 42000);
    await send(dependent);
    await waitUntil(
      () =>
        reader.packets.some((packet) =>
          packet.subarray(12).equals(dependent.subarray(12)),
        ),
      "fresh IDR and its following P-frame should reach the reader",
    );
    const live = reader.packets.slice(cached.length);
    // Parameter sets may be repeated immediately before the fresh IDR.
    const livePictures = live.filter(
      (packet) => ![7, 8].includes(packet[12] & 0x1f),
    );
    assert.equal(livePictures.length, fresh.length + 1);
    for (let index = 0; index < fresh.length; index++)
      assert.deepEqual(
        livePictures[index].subarray(12),
        fresh[index].subarray(12),
      );
    assert.deepEqual(livePictures.at(-1).subarray(12), dependent.subarray(12));
    assert.equal(
      (livePictures.at(-1).readUInt32BE(4) -
        livePictures.at(-2).readUInt32BE(4)) >>>
        0,
      6000,
      "the first dependent frame keeps its source video clock after the clean IDR, even when both arrive together",
    );
  },
);
