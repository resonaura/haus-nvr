import test from "node:test";
import assert from "node:assert/strict";
import { dockerTelemetry, pm2Telemetry } from "../lib/service-telemetry.mjs";
import { parseWindowsServices } from "../lib/system-service-telemetry.mjs";
import { sanitizeHostReport } from "../lib/host-telemetry.mjs";

for (const [engine, basis] of [
  ["linux", "core"],
  ["windows", "host"],
  ["other", null],
]) {
  test(`Docker declares ${engine} engine CPU units independently of the CLI platform`, async () => {
    const value = await dockerTelemetry(async (_file, args) =>
      args[0] === "info"
        ? JSON.stringify({ OSType: engine })
        : args[0] === "ps"
          ? '{"ID":"fixture","Names":"Fixture","State":"running"}'
          : '{"ID":"fixture","CPUPerc":"110.7%","MemUsage":"1MiB / 2MiB"}',
    );
    assert.equal(value.available, true);
    assert.equal(value.cpuPercentBasis, basis);
    assert.equal(value.containers[0].cpuPercent, 110.7);
  });
}
test("failed engine discovery keeps the list but does not guess CPU units", async () => {
  const value = await dockerTelemetry(async (_file, args) => {
    if (args[0] === "info") throw Error("unavailable");
    return args[0] === "ps"
      ? '{"ID":"fixture","Names":"Fixture","State":"running"}'
      : '{"ID":"fixture","CPUPerc":"10%"}';
  });
  assert.equal(value.available, true);
  assert.equal(value.cpuPercentBasis, null);
});
test("PM2 pidusage and native Windows service process time retain their known per-core basis", async () => {
  const pm2 = await pm2Telemetry({
    read: async () => "12",
    alive: () => {},
    run: async () => '[{"name":"Fixture","monit":{"cpu":110.7}}]',
  });
  assert.equal(pm2.cpuPercentBasis, "core");
  assert.equal(
    parseWindowsServices({ Services: [], Processes: [] }).cpuPercentBasis,
    "core",
  );
});
test("external reports preserve explicit CPU accounting without accepting arbitrary units", () => {
  const value = {
    sampledAt: new Date().toISOString(),
    scope: "host",
    cpu: { logicalCores: 4 },
    memory: { totalBytes: 1000, usedBytes: 500, availableBytes: 500 },
    docker: { available: true, cpuPercentBasis: "host", containers: [] },
    pm2: { available: true, cpuPercentBasis: "core", processes: [] },
  };
  assert.equal(sanitizeHostReport(value).docker.cpuPercentBasis, "host");
  assert.equal(sanitizeHostReport(value).pm2.cpuPercentBasis, "core");
  value.docker.cpuPercentBasis = "guess";
  assert.equal(sanitizeHostReport(value).docker.cpuPercentBasis, null);
});
