import { test } from "node:test";
import assert from "node:assert/strict";
import { Capacity } from "../lib/capacity.mjs";
test("weak container quotas bound workers even on a large host and pressure stops new work", async (t) => {
  let used = 100 * 1024 ** 2;
  const values = {
    "cpu.max": "75000 100000",
    "memory.max": String(512 * 1024 ** 2),
    "cpu.stat": "usage_usec 1",
  };
  const capacity = await new Capacity({
    cpus: 32,
    memory: 64 * 1024 ** 3,
    read: async (path) =>
      path.endsWith("memory.current")
        ? String(used)
        : (values[path.split("/").at(-1)] ?? ""),
  }).initialize();
  t.after(() => capacity.stop());
  assert.equal(capacity.cpus, 0.75);
  assert.equal(capacity.memory, 512 * 1024 ** 2);
  assert.equal(capacity.streams, 1);
  assert.equal(capacity.detectors, 1);
  assert.equal(capacity.pressured, false);
  used = 480 * 1024 ** 2;
  await capacity.sample();
  assert.equal(capacity.pressured, true);
  values["memory.stat"] =
    `anon ${100 * 1024 ** 2}\ninactive_file ${380 * 1024 ** 2}\nshmem ${10 * 1024 ** 2}\n`;
  await capacity.sample();
  assert.equal(capacity.memoryUsed, 100 * 1024 ** 2);
  assert.equal(capacity.pressured, false);
  assert.equal(capacity.status().memoryCurrentBytes, used);
  // Active/shared pages cannot be discarded as though they were idle cache.
  values["memory.stat"] =
    `active_file ${380 * 1024 ** 2}\nshmem ${10 * 1024 ** 2}\n`;
  await capacity.sample();
  assert.equal(capacity.pressured, true);
});
test("optional analysis yields to measured whole-host PSI without stopping camera capacity", async (t) => {
  let memory = "full avg10=0.10 avg60=0.00 avg300=0.00 total=1",
    io = "full avg10=25.00 avg60=0.00 avg300=0.00 total=1";
  const capacity = await new Capacity({
    cpus: 2,
    memory: 1024 ** 3,
    read: async (path) =>
      path === "/proc/pressure/memory"
        ? memory
        : path === "/proc/pressure/io"
          ? io
          : "",
  }).initialize();
  t.after(() => capacity.stop());
  assert.equal(capacity.pressured, false);
  assert.equal(capacity.analysisPressured, true);
  assert.equal(capacity.status().hostPressure.ioFull, 25);
  io = "full avg10=1.00 avg60=0.00 avg300=0.00 total=1";
  memory = "full avg10=5.01 avg60=0.00 avg300=0.00 total=1";
  await capacity.sample();
  assert.equal(capacity.analysisPressured, true);
  memory = io = "unsupported";
  await capacity.sample();
  assert.equal(capacity.status().hostPressure.memoryFull, null);
  assert.equal(capacity.analysisPressured, false);
  assert.equal(capacity.streams, 4);
});
