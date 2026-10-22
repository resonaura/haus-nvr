import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeRecording } from "../lib/playback-process.mjs";

const exec = promisify(execFile);
test("real playback conversion retains video dimensions, moving frames and audio while ending at video rather than a long audio tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-playback-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "original.mp4"),
    output = join(root, "playback.mp4");
  await exec("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-t",
    "2",
    "-i",
    "testsrc2=size=160x90:rate=20",
    "-f",
    "lavfi",
    "-t",
    "6",
    "-i",
    "sine=frequency=440:sample_rate=16000",
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
  const original = await readFile(input);
  await assert.rejects(
    () =>
      normalizeRecording({
        input,
        output: input,
        audioTrimSeconds: 0,
        maxBytes: 1024,
      }),
    /invalid_media/,
  );
  await assert.rejects(
    () =>
      normalizeRecording({
        input,
        output: join(root, "too-large.mp4"),
        audioTrimSeconds: 0,
        maxBytes: 4 * 1024 ** 2,
        memoryBudget: 1,
      }),
    /media_capacity/,
  );
  const result = await normalizeRecording({
    input,
    output,
    audioTrimSeconds: 0,
    maxBytes: 4 * 1024 ** 2,
  });
  assert.equal(result.width, 160);
  assert.equal(result.height, 90);
  assert.equal(result.audio, true);
  assert.ok(Math.abs(result.duration - 2) < 0.1);
  const probe = JSON.parse(
    (
      await exec("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_type,codec_name,nb_read_frames,duration:format=duration",
        "-of",
        "json",
        output,
      ])
    ).stdout,
  );
  assert.equal(
    probe.streams.find((s) => s.codec_type === "video").nb_read_frames,
    "40",
  );
  assert.equal(
    probe.streams.find((s) => s.codec_type === "audio").codec_name,
    "aac",
  );
  assert.ok(Number(probe.format.duration) < 2.2);
  const decoded = await exec("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
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
  assert.equal(decoded.stderr, "");
  assert.deepEqual(await readFile(input), original);

  const silent = join(root, "silent.mp4");
  await exec("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    input,
    "-an",
    "-c:v",
    "copy",
    silent,
  ]);
  const withoutAudio = await normalizeRecording({
    input: silent,
    output: join(root, "silent-playback.mp4"),
    audioTrimSeconds: 0,
    maxBytes: 4 * 1024 ** 2,
  });
  assert.equal(withoutAudio.audio, false);
});

test("non-MP4 input cannot become a network playlist or an arbitrary local-file input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-playback-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  await writeFile(input, "#EXTM3U\n#EXTINF:5,\nhttp://127.0.0.1:1/private\n");
  await assert.rejects(
    () =>
      normalizeRecording({
        input,
        output: join(root, "output.mp4"),
        audioTrimSeconds: 0,
        maxBytes: 1024,
      }),
    /media_process_failed|invalid_media/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () =>
      normalizeRecording({
        input,
        output: join(root, "cancelled.mp4"),
        audioTrimSeconds: 0,
        maxBytes: 1024,
        signal: abort.signal,
      }),
    { name: "AbortError" },
  );
});
