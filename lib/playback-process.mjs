import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Only local MP4 inputs and a fixed playback profile reach FFmpeg. */
function mediaProcess(command, args, { signal, timeout = 30000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "",
      failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, timeout);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => {
      failed = true;
    });
    child.stdout.on("data", (data) => {
      if (output.length + data.length > 1000000) abort();
      else output += data;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0 && !failed) resolve(output);
      else
        reject(
          new Error(signal?.aborted ? "media_aborted" : "media_process_failed"),
        );
    });
  });
}

async function metadata(path, signal) {
  const raw = await mediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "mov",
      "-enable_drefs",
      "0",
      "-use_absolute_path",
      "0",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,duration",
      "-of",
      "json",
      path,
    ],
    { signal },
  );
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("invalid_media");
  }
  const video = data.streams?.find((s) => s.codec_type === "video");
  const duration = Number(video?.duration ?? data.format?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration < 0.1 ||
    duration > 600 ||
    !(video.width > 0 && video.height > 0) ||
    video.width > 4096 ||
    video.height > 4096 ||
    video.width * video.height > 3840 * 2160 ||
    video.width % 2 ||
    video.height % 2
  )
    throw new Error("invalid_media");
  return {
    duration,
    width: video.width,
    height: video.height,
    audio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

export async function normalizeRecording({
  input,
  output,
  audioTrimSeconds,
  maxBytes,
  signal,
  memoryBudget = Infinity,
}) {
  if (resolve(input) === resolve(output)) throw new Error("invalid_media");
  const source = await metadata(input, signal);
  // Conservative frame/lookahead allowance; retain source resolution or decline.
  if (source.width * source.height * 96 > memoryBudget)
    throw new Error("media_capacity");
  const audio =
    audioTrimSeconds > 0
      ? `atrim=start=${audioTrimSeconds},asetpts=PTS-STARTPTS,aresample=async=1000:first_pts=0,apad`
      : "aresample=async=1000:first_pts=0,apad";
  await mediaProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file",
      "-f",
      "mov",
      "-enable_drefs",
      "0",
      "-use_absolute_path",
      "0",
      "-threads",
      "2",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-threads",
      "2",
      "-filter_threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "fps=20:start_time=0",
      "-fps_mode",
      "cfr",
      "-g",
      "40",
      "-keyint_min",
      "20",
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      "-video_track_timescale",
      "90000",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-af",
      audio,
      "-shortest",
      "-movflags",
      "+faststart",
      "-fs",
      String(maxBytes),
      output,
    ],
    {
      signal,
      timeout: Math.min(480000, Math.max(120000, source.duration * 5000)),
    },
  );
  const result = await metadata(output, signal);
  if (
    result.width !== source.width ||
    result.height !== source.height ||
    Math.abs(result.duration - source.duration) > 1 ||
    (source.audio && !result.audio)
  )
    throw new Error("invalid_prepared_media");
  return result;
}
