import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const FRAME = 320 * 180 * 3;
/** Drop frames while inference is busy. Never queue seconds of obsolete motion analysis. */
export class VisionWorker {
  constructor({
    source,
    mode = "objects",
    headers,
    onDetection = () => {},
    spawnProcess = spawn,
    interval = 1500,
  }) {
    if (!["objects", "motion"].includes(mode))
      throw new Error("invalid_detection_mode");
    this.children = [];
    this.state = "starting";
    this.lastFrame = this.lastResult = Date.now();
    const python = spawnProcess(
      process.env.HAUS_VISION_PYTHON || "/opt/vision-env/bin/python3",
      [fileURLToPath(new URL("./motion.py", import.meta.url)), mode],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
        },
      },
    );
    this.children.push(python);
    let line = "",
      ready = false,
      busy = false,
      due = 0,
      capturedAt = 0;
    python.stdout.on("data", (chunk) => {
      line = (line + chunk).slice(-16000);
      const lines = line.split("\n");
      line = lines.pop() || "";
      for (const value of lines) {
        try {
          const item = JSON.parse(value);
          if (item.type === "ready") ready = true;
          if (item.type === "frame") {
            busy = false;
            this.lastResult = Date.now();
            this.state = "running";
            this.processingMs = item.processingMs;
            for (const detection of (item.detections || []).slice(0, 3))
              if (
                ["person", "pet", "vehicle", "motion"].includes(detection.kind)
              )
                onDetection({ ...detection, at: capturedAt });
          }
        } catch {
          /* An invalid diagnostic line cannot create a detection. */
        }
      }
    });
    python.stdin.on("error", () => this.fail());
    const decoder = spawnProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-rw_timeout",
        "15000000",
        "-threads",
        "1",
        "-skip_frame",
        "nokey",
        ...(headers ? ["-headers", headers] : []),
        "-live_start_index",
        "-1",
        "-i",
        source,
        "-an",
        "-vf",
        "fps=1,scale=320:180:flags=area",
        "-threads",
        "1",
        "-pix_fmt",
        "bgr24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.children.push(decoder);
    let pending = Buffer.alloc(FRAME),
      offset = 0;
    decoder.stdout.on("data", (chunk) => {
      let start = 0;
      while (start < chunk.length) {
        const length = Math.min(FRAME - offset, chunk.length - start);
        chunk.copy(pending, offset, start, start + length);
        start += length;
        offset += length;
        if (offset === FRAME) {
          this.lastFrame = Date.now();
          if (ready && !busy && this.lastFrame >= due && !this.stopped) {
            busy = true;
            capturedAt = this.lastFrame;
            due =
              this.lastFrame + Math.max(interval, (this.processingMs || 0) * 4);
            python.stdin.write(pending);
            pending = Buffer.alloc(FRAME);
          }
          offset = 0;
        }
      }
    });
    for (const child of this.children) {
      child.stderr.on("data", () => {});
      child.on("error", () => this.fail());
      child.on("exit", () => {
        if (!this.stopped) this.fail();
      });
    }
    this.timer = setInterval(() => {
      if (
        Date.now() - this.lastFrame > 25000 ||
        Date.now() - this.lastResult > 30000
      )
        this.fail();
    }, 5000);
    this.timer.unref();
  }
  fail() {
    if (!this.stopped) {
      this.state = "failed";
      void this.stop();
    }
  }
  async stop() {
    if (this.stopped) return this.stopping;
    this.stopped = true;
    clearInterval(this.timer);
    this.stopping = Promise.allSettled(
      this.children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
            timer.unref();
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill("SIGTERM");
          }),
      ),
    );
    return this.stopping;
  }
}
