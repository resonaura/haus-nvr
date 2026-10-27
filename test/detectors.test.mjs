import { test } from "node:test";
import assert from "node:assert/strict";
import { Detectors } from "../lib/detectors.mjs";
test("inference jobs obey quotas, isolate capabilities, bound event history and expire", async (t) => {
  let at = 1000,
    options,
    stopped = 0;
  const capacity = {
    pressured: false,
    detectors: 1,
    memory: 512,
    memoryUsed: 100,
  };
  const jobs = new Detectors("http://helper.test:8099", capacity, {
    now: () => at,
    worker: (input) => {
      options = input;
      return {
        state: "running",
        stop: async () => {
          stopped++;
        },
      };
    },
  });
  jobs.supported = true;
  t.after(() => jobs.stop());
  assert.throws(
    () => jobs.start("http://another.test/private"),
    /invalid_detector_source/,
  );
  const source = `http://helper.test:8099/cluster/source/${"a".repeat(48)}/${"b".repeat(24)}.m3u8`;
  capacity.playbackBusy = true;
  assert.throws(() => jobs.start(source), /detector_busy/);
  capacity.playbackBusy = false;
  const { id } = jobs.start(source);
  assert.throws(() => jobs.start(source), /detector_busy/);
  for (let index = 0; index < 100; index++)
    options.onDetection({ kind: "person", at });
  assert.equal(jobs.jobs.get(id).events.length, 64);
  assert.equal(jobs.jobs.get(id).events.at(-1).sequence, 100);
  at += 46000;
  await jobs.prune();
  assert.equal(jobs.jobs.size, 0);
  assert.equal(stopped, 1);
  capacity.pressured = true;
  assert.throws(() => jobs.start(source), /detector_busy/);
});
test("host pressure pauses new analysis and retires sustained overload without touching streams", async (t) => {
  let at = 100000,
    stopped = 0;
  const capacity = {
    detectors: 1,
    memory: 1024,
    memoryUsed: 100,
    pressured: false,
    analysisPressured: false,
  };
  const jobs = new Detectors("http://helper.test:8099", capacity, {
    now: () => at,
    worker: () => ({ state: "running", stop: async () => stopped++ }),
  });
  t.after(() => jobs.stop());
  jobs.supported = true;
  const source = `http://helper.test:8099/cluster/source/${"a".repeat(48)}/${"b".repeat(24)}.m3u8`;
  jobs.start(source);
  capacity.analysisPressured = true;
  assert.equal(jobs.status().max, 0);
  await jobs.prune();
  at += 10000;
  await jobs.prune();
  assert.equal(stopped, 0);
  capacity.analysisPressured = false;
  await jobs.prune();
  capacity.analysisPressured = true;
  await jobs.prune();
  at += 21000;
  await jobs.prune();
  assert.equal(stopped, 1);
  assert.equal(jobs.jobs.size, 0);
  assert.equal(capacity.pressured, false);
});
