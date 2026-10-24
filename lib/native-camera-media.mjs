import { spawn } from "node:child_process";
import { createServer } from "node:net";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { privateIp } from "./camera-source.mjs";

const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const safeMediaError = (value) =>
  String(value ?? "")
    .replace(/rtsps?:\/\/[^\s'"<>]+/gi, "[redacted RTSP URL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted IP]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-320);
async function reservePort(protocol) {
  if (protocol === "tcp") {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      port: server.address().port,
      release: () => new Promise((resolve) => server.close(resolve)),
    };
  }
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  return {
    port: socket.address().port,
    release: () => new Promise((resolve) => socket.close(resolve)),
  };
}

/** Haus-owned libdatachannel/WebRTC and RTSP media worker. */
export class NativeCameraMedia {
  constructor(
    _root,
    {
      binary = process.env.HAUS_CAMERA_MEDIA_BIN ||
        "/usr/local/bin/haus-camera-media",
      ffmpeg = process.env.HAUS_FFMPEG_BIN || "ffmpeg",
      spawnProcess = spawn,
      now = Date.now,
      viewerLimit = 12,
      readyTimeoutMs = 20000,
      log = (event, fields) =>
        console.log(
          JSON.stringify({ component: "camera-media", event, ...fields }),
        ),
    } = {},
  ) {
    Object.assign(this, {
      binary,
      ffmpeg,
      spawnProcess,
      now,
      viewerLimit,
      readyTimeoutMs,
      logger: log,
    });
    this.sessions = new Map();
    this.viewers = new Map();
    this.waiters = new Map();
    this.terminating = new Set();
    this.lineBuffer = "";
    this.failed = false;
    this.stopping = false;
  }

  log(event, fields = {}) {
    try {
      this.logger(event, fields);
    } catch {
      // Diagnostics must never disrupt a camera session.
    }
  }

  async initialize(advertiseHost) {
    if (!privateIp(advertiseHost)) throw new Error("invalid_camera_candidate");
    if (this.advertiseHost && this.advertiseHost !== advertiseHost)
      throw new Error("invalid_camera_candidate");
    this.advertiseHost = advertiseHost;
    if (this.ready && !this.failed) return this.ready;
    this.ready = this.start();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  async start() {
    this.failed = false;
    this.stopping = false;
    const child = this.spawnProcess(this.binary, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child = child;
    this.exit = new Promise((resolve) => child.once("close", resolve));
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.on("error", () => this.fail());
    child.on("close", () => this.fail());
    await this.waitFor("", "ready", 5000);
  }

  onData(chunk) {
    this.lineBuffer += chunk.toString("utf8");
    if (this.lineBuffer.length > 256 * 1024) return this.fail();
    for (;;) {
      const end = this.lineBuffer.indexOf("\n");
      if (end < 0) break;
      const line = this.lineBuffer.slice(0, end).trim();
      this.lineBuffer = this.lineBuffer.slice(end + 1);
      if (!line || line.length > 65536) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.onEvent(event);
    }
  }

  onEvent(event) {
    if (event?.event === "rtp_stats") {
      const session = this.sessions.get(event.did);
      if (
        session &&
        ["source", "viewer"].includes(event.stage) &&
        ["video", "audio"].includes(event.media)
      ) {
        const counts = {};
        for (const name of [
          "packets",
          "bytes",
          "sequence_gaps",
          "kernel_drops",
          "truncated",
          "receive_buffer_bytes",
        ])
          if (Number.isSafeInteger(event[name]) && event[name] >= 0)
            counts[name] = event[name];
        this.log("rtp_ingress_stats", {
          cameraId: session.cameraId,
          ...(uuid(event.viewer_id) ? { viewerId: event.viewer_id } : {}),
          stage: event.stage,
          media: event.media,
          ...counts,
        });
      }
      return;
    }
    if (event?.event === "ready") this.resolve("", "ready", event);
    if (event?.event === "relay_started" || event?.event === "relay_reset")
      this.resolve(event.did, event.event, event);
    if (event?.event === "relay_ready") {
      const session = this.sessions.get(event.did);
      if (session) {
        session.mediaReadyAt = this.now();
        session.restarts = 0;
        session.readyResolve?.();
        this.log("source_media_ready", {
          cameraId: session.cameraId,
          sourceKind: session.sourceKind,
          startupMs: Math.max(
            0,
            this.now() - (session.producerStartedAt ?? session.startedAt),
          ),
          audio: true,
          video: true,
        });
      }
    } else if (event?.event === "viewer_offer") {
      this.resolve(event.viewer_id, "viewer_offer", event);
    } else if (event?.event === "viewer_state" && event.state === "connected") {
      const viewer = this.viewers.get(event.viewer_id);
      if (viewer) {
        viewer.connected = true;
        clearTimeout(viewer.connectTimer);
        this.log("viewer_connected", {
          cameraId: viewer.session.cameraId,
          viewerId: viewer.id,
          handshakeMs: Math.max(0, this.now() - viewer.startedAt),
        });
        this.activateViewer(viewer);
      }
    } else if (event?.event === "viewer_state" && event.state === "closed") {
      const viewer = this.viewers.get(event.viewer_id);
      if (viewer) this.closeViewer(event.viewer_id, viewer.owner);
    } else if (event?.event === "error") {
      if (event.viewer_id) this.reject(event.viewer_id, "viewer_offer");
      else {
        this.reject(event.did, "relay_started");
        this.reject(event.did, "relay_reset");
        for (const viewer of this.viewers.values())
          if (viewer.session.id === event.did)
            this.reject(viewer.id, "viewer_offer");
      }
    }
  }

  fail() {
    if (this.stopping) return;
    this.failed = true;
    for (const [key, waiter] of this.waiters) {
      this.waiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("camera_engine_unavailable"));
    }
    for (const id of this.viewers.keys()) this.closeViewer(id);
  }

  send(value) {
    if (
      this.failed ||
      this.stopping ||
      !this.child ||
      this.child.exitCode !== null
    )
      throw new Error("camera_engine_unavailable");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  waitFor(id, eventName, timeoutMs = 5000) {
    const key = `${id}:${eventName}`;
    if (this.waiters.has(key)) throw new Error("camera_engine_busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error("camera_engine_timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  resolve(id, eventName, value) {
    const key = `${id}:${eventName}`,
      waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  reject(id, eventName) {
    const key = `${id}:${eventName}`,
      waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.reject(new Error("camera_media_failed"));
  }

  async command(value, eventName, timeoutMs = 5000) {
    const reply = this.waitFor(value.did, eventName, timeoutMs);
    try {
      this.send(value);
    } catch (error) {
      this.reject(value.did, eventName);
      throw error;
    }
    return reply;
  }

  async add(id, source, { sourceKind = "rtsp", cameraId = id } = {}) {
    if (!uuid(id) || typeof source !== "string" || source.length > 4096)
      throw new Error("invalid_camera_session");
    if (
      !["rtsp", "p2p-restream"].includes(sourceKind) ||
      typeof cameraId !== "string"
    )
      throw new Error("invalid_camera_session");
    if (this.sessions.has(id)) throw new Error("camera_session_exists");
    const reservations = [];
    let session;
    try {
      reservations.push(await reservePort("tcp"));
      reservations.push(await reservePort("udp"));
      reservations.push(await reservePort("udp"));
    } catch (error) {
      await Promise.allSettled(reservations.map(({ release }) => release()));
      throw error;
    }
    session = {
      id,
      cameraId,
      sourceKind,
      source,
      startedAt: this.now(),
      rtspPort: reservations[0].port,
      videoPort: reservations[1].port,
      audioPort: reservations[2].port,
      viewers: new Set(),
      stopped: false,
      restarts: 0,
      mediaReadyAt: 0,
    };
    session.readyPromise = this.newReadyPromise(session);
    this.sessions.set(id, session);
    try {
      await Promise.all(reservations.map(({ release }) => release()));
      await this.command(
        {
          cmd: "start_relay",
          did: id,
          rtsp_port: session.rtspPort,
          rtp_port: session.videoPort,
          audio_rtp_port: session.audioPort,
          rtsp_path: id,
        },
        "relay_started",
      );
      await this.startProducer(session, false);
    } catch {
      this.log("source_session_start_failed", {
        cameraId,
        sourceKind,
      });
      await this.remove(id);
      throw new Error("camera_engine_unavailable");
    }
  }

  newReadyPromise(session) {
    return new Promise((resolve) => {
      session.readyResolve = resolve;
    });
  }

  producerArgs(session) {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "15000000",
      "-fflags",
      "+genpts+discardcorrupt",
      "-analyzeduration",
      "1000000",
      "-probesize",
      "1000000",
      "-i",
      session.source,
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "copy",
      "-bsf:v",
      "dump_extra=freq=keyframe",
      "-f",
      "rtp",
      "-payload_type",
      "96",
      `rtp://127.0.0.1:${session.videoPort}?pkt_size=1200`,
      "-map",
      "0:a:0",
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
      `rtp://127.0.0.1:${session.audioPort}?pkt_size=1200`,
    ];
  }

  async startProducer(session, restart) {
    if (session.stopped || this.sessions.get(session.id) !== session) return;
    if (restart) {
      this.log("source_reader_restarting", {
        cameraId: session.cameraId,
        sourceKind: session.sourceKind,
        attempt: Math.max(1, session.restarts),
      });
      session.mediaReadyAt = 0;
      session.readyPromise = this.newReadyPromise(session);
      await this.command(
        { cmd: "reset_relay", did: session.id },
        "relay_reset",
      );
    }
    const child = this.spawnProcess(this.ffmpeg, this.producerArgs(session), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    session.producerStartedAt = this.now();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    session.producer = child;
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("camera_media_spawn_timeout")),
        5000,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        this.log("source_reader_spawn_failed", {
          cameraId: session.cameraId,
          sourceKind: session.sourceKind,
          errorCode:
            typeof error?.code === "string"
              ? error.code.slice(0, 64)
              : "unknown",
        });
        reject(new Error("camera_media_spawn_failed"));
      });
    });
    child.once("close", () => {
      if (session.producer === child) session.producer = undefined;
      if (!session.stopped && this.sessions.get(session.id) === session) {
        this.log("source_reader_closed", {
          cameraId: session.cameraId,
          sourceKind: session.sourceKind,
          exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
          signal:
            typeof child.signalCode === "string" ? child.signalCode : null,
          detail: safeMediaError(stderr) || undefined,
        });
        this.scheduleProducerRestart(session);
      }
    });
    await started;
  }

  scheduleProducerRestart(session) {
    if (session.restartTimer || session.stopped) return;
    const delay = Math.min(30000, 500 * 2 ** Math.min(session.restarts++, 6));
    session.restartTimer = setTimeout(() => {
      session.restartTimer = undefined;
      void this.startProducer(session, true).catch(() =>
        this.scheduleProducerRestart(session),
      );
    }, delay);
    session.restartTimer.unref?.();
  }

  localRtsp(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("camera_session_not_found");
    return `rtsp://127.0.0.1:${session.rtspPort}/${id}`;
  }

  async waitUntilReady(session) {
    if (session.mediaReadyAt && this.now() - session.mediaReadyAt < 30000)
      return;
    let timer;
    try {
      await Promise.race([
        session.readyPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("camera_stream_warming")),
            this.readyTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  viewerArgs(session, viewer) {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "15000000",
      "-fflags",
      "+genpts",
      "-analyzeduration",
      "1000000",
      "-probesize",
      "1000000",
      "-i",
      this.localRtsp(session.id),
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "copy",
      "-bsf:v",
      "dump_extra=freq=keyframe",
      "-f",
      "rtp",
      "-payload_type",
      "96",
      `rtp://127.0.0.1:${viewer.videoPort}?pkt_size=1200`,
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "libopus",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-b:a",
      "48k",
      "-application",
      "lowdelay",
      "-f",
      "rtp",
      "-payload_type",
      "111",
      `rtp://127.0.0.1:${viewer.audioPort}?pkt_size=1200`,
    ];
  }

  async startViewerProcess(viewer) {
    if (viewer.closed || this.viewers.get(viewer.id) !== viewer) return;
    const child = this.spawnProcess(
      this.ffmpeg,
      this.viewerArgs(viewer.session, viewer),
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    viewer.process = child;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("camera_viewer_spawn_timeout")),
        5000,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("camera_viewer_spawn_failed"));
      });
    });
    child.once("close", () => {
      if (viewer.process === child) viewer.process = undefined;
      if (!viewer.closed && this.viewers.get(viewer.id) === viewer) {
        this.log("viewer_reader_closed", {
          cameraId: viewer.session.cameraId,
          viewerId: viewer.id,
          exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
          signal:
            typeof child.signalCode === "string" ? child.signalCode : null,
          detail: safeMediaError(stderr) || undefined,
        });
        if (viewer.restarts++ >= 2) this.closeViewer(viewer.id, viewer.owner);
        else {
          const timer = setTimeout(
            () =>
              void this.startViewerProcess(viewer).catch(() =>
                this.closeViewer(viewer.id, viewer.owner),
              ),
            250 * 2 ** viewer.restarts,
          );
          timer.unref?.();
          viewer.restartTimer = timer;
        }
      }
    });
  }

  activateViewer(viewer) {
    if (
      viewer.closed ||
      !viewer.connected ||
      !viewer.signaled ||
      viewer.process ||
      viewer.starting ||
      this.viewers.get(viewer.id) !== viewer
    )
      return;
    viewer.starting = this.startViewerProcess(viewer)
      .catch(() => {
        this.log("viewer_reader_start_failed", {
          cameraId: viewer.session.cameraId,
          viewerId: viewer.id,
        });
        this.closeViewer(viewer.id, viewer.owner);
      })
      .finally(() => {
        viewer.starting = undefined;
      });
  }

  rewriteAnswer(sdp) {
    if (typeof sdp !== "string" || sdp.length > 65536)
      throw new Error("camera_webrtc_failed");
    return sdp.replace(
      /^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+)\S+(\s+\d+\s+typ host\b.*)$/gm,
      `$1${this.advertiseHost}$2`,
    );
  }

  async offer(sessionId, owner, offer) {
    const session = this.sessions.get(sessionId);
    if (!session || this.failed || this.stopping)
      throw new Error("camera_engine_unavailable");
    if (
      typeof offer !== "string" ||
      offer.length > 65536 ||
      !offer.startsWith("v=0") ||
      !/^m=video /m.test(offer) ||
      !/^m=audio /m.test(offer) ||
      !/a=rtpmap:\d+\s+opus\/48000/i.test(offer) ||
      /^a=(?:sendonly|sendrecv)$/m.test(offer)
    )
      throw new Error("invalid_camera_offer");
    if (this.viewers.size >= this.viewerLimit)
      throw new Error("camera_viewer_busy");
    const readinessStartedAt = this.now();
    try {
      await this.waitUntilReady(session);
    } catch (error) {
      this.log("viewer_wait_failed", {
        cameraId: session.cameraId,
        sourceKind: session.sourceKind,
        waitedMs: Math.max(0, this.now() - readinessStartedAt),
        reason:
          error.message === "camera_stream_warming"
            ? "warming_timeout"
            : "media_unavailable",
      });
      throw error;
    }
    const viewer = {
      id: randomUUID(),
      session,
      owner,
      startedAt: this.now(),
      videoPort: 0,
      audioPort: 0,
      closed: false,
      connected: false,
      signaled: false,
      restarts: 0,
    };
    const response = this.waitFor(viewer.id, "viewer_offer", 8000);
    this.viewers.set(viewer.id, viewer);
    session.viewers.add(viewer.id);
    try {
      this.send({
        cmd: "start_viewer",
        viewer_id: viewer.id,
        did: sessionId,
        sdp: offer,
      });
      const answer = await response;
      viewer.videoPort = answer.rtp_port;
      viewer.audioPort = answer.audio_rtp_port;
      if (!viewer.videoPort || !viewer.audioPort)
        throw new Error("camera_webrtc_failed");
      viewer.signaled = true;
      if (!viewer.connected) {
        viewer.connectTimer = setTimeout(
          () => this.closeViewer(viewer.id, viewer.owner),
          15000,
        );
        viewer.connectTimer.unref?.();
      }
      this.activateViewer(viewer);
      return {
        viewerId: viewer.id,
        answer: { type: "answer", sdp: this.rewriteAnswer(answer.sdp) },
        candidates: [],
      };
    } catch {
      this.closeViewer(viewer.id, owner);
      throw new Error("camera_webrtc_failed");
    }
  }

  stopViewerProcess(viewer) {
    clearTimeout(viewer.restartTimer);
    const child = viewer.process;
    viewer.process = undefined;
    if (child) this.trackTermination(child);
  }

  trackTermination(child) {
    const task = this.terminate(child).finally(() =>
      this.terminating.delete(task),
    );
    this.terminating.add(task);
    return task;
  }

  async terminate(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
  }

  closeViewer(id, owner) {
    const viewer = this.viewers.get(id);
    if (!viewer || (owner !== undefined && owner !== viewer.owner)) return;
    viewer.closed = true;
    this.log("viewer_closed", {
      cameraId: viewer.session.cameraId,
      viewerId: id,
    });
    clearTimeout(viewer.connectTimer);
    this.viewers.delete(id);
    viewer.session.viewers.delete(id);
    this.reject(id, "viewer_offer");
    this.stopViewerProcess(viewer);
    try {
      this.send({ cmd: "stop_viewer", viewer_id: id });
    } catch {}
  }

  async remove(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopped = true;
    clearTimeout(session.restartTimer);
    this.sessions.delete(id);
    for (const viewerId of session.viewers) this.closeViewer(viewerId);
    if (session.producer) await this.trackTermination(session.producer);
    try {
      this.send({ cmd: "stop_relay", did: id });
    } catch {}
  }

  async stop() {
    if (this.stopping) return this.exit;
    this.stopping = true;
    for (const id of [...this.sessions.keys()]) await this.remove(id);
    for (const id of [...this.viewers.keys()]) this.closeViewer(id);
    await Promise.allSettled([...this.terminating]);
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.write('{"cmd":"exit"}\n');
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      this.child.stdin.end();
      await this.exit;
      clearTimeout(kill);
    }
    this.failed = true;
  }
}
