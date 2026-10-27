import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { VisionWorker } from "../vision/worker.mjs";
test("slow inference keeps one frame in flight and drops stale frames without overwriting it", async () => {
  const children = [],
    frames = [],
    detections = [];
  const worker = new VisionWorker({
    source: "http://fixture.test/index.m3u8",
    interval: 0,
    onDetection: (event) => detections.push(event),
    spawnProcess: () => {
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      child.kill = () => {
        child.signalCode = "SIGTERM";
        queueMicrotask(() => child.emit("close"));
        return true;
      };
      children.push(child);
      return child;
    },
  });
  const [python, decoder] = children;
  python.stdin.on("data", (frame) => frames.push(frame));
  python.stdout.write('{"type":"ready"}\n');
  for (let index = 0; index < 100; index++)
    decoder.stdout.emit("data", Buffer.alloc(320 * 180 * 3, index));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 0);
  assert.equal(frames[0].at(-1), 0);
  python.stdout.write(
    '{"type":"frame","calibrated":false,"processingMs":0,"detections":[{"kind":"person"}]}\n',
  );
  decoder.stdout.emit("data", Buffer.alloc(320 * 180 * 3, 123));
  assert.equal(frames.length, 2);
  assert.equal(frames[1][0], 123);
  assert.equal(detections.length, 0);
  assert.equal(worker.calibrated, false);
  python.stdout.write(
    '{"type":"frame","calibrated":true,"processingMs":0,"detections":[{"kind":"person"}]}\n',
  );
  assert.equal(detections.length, 1);
  assert.equal(worker.calibrated, true);
  assert.equal(worker.state, "running");
  await worker.stop();
  assert.ok(children.every((child) => child.signalCode === "SIGTERM"));
});
