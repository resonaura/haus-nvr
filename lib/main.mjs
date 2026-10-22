import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { RecordingIndex } from "./recording-index.mjs";
import { Catalog } from "./catalog.mjs";
import { randomUUID } from "node:crypto";
import { WorkerStreams } from "./streams.mjs";
import { Blobs } from "./blobs.mjs";
import { createNode } from "./server.mjs";
import { Capacity } from "./capacity.mjs";
import { Detectors } from "./detectors.mjs";
import { Playback } from "./playback.mjs";
const root = resolve(process.env.HAUS_DATA || "/data");
await mkdir(root, { recursive: true, mode: 0o700 });
const key = (
  process.env.HAUS_NODE_KEY_FILE
    ? await readFile(process.env.HAUS_NODE_KEY_FILE, "utf8")
    : process.env.HAUS_NODE_KEY || ""
).trim();
const maxGB = Number(process.env.HAUS_MAX_STORAGE_GB || 100);
if (!Number.isFinite(maxGB) || maxGB < 1 || maxGB > 100000)
  throw new Error("Invalid storage budget");
const roles = (process.env.HAUS_ROLES || "storage,stream").split(",");
if (!roles.length || roles.some((r) => !["storage", "stream"].includes(r)))
  throw new Error("Invalid roles");
const blobs = new Blobs(join(root, "blobs"), { maxBytes: maxGB * 1024 ** 3 });
await blobs.initialize();
const origin = process.env.HAUS_SOURCE_ORIGIN
  ? new URL(process.env.HAUS_SOURCE_ORIGIN).origin
  : undefined;
if (origin && !/^https?:/.test(origin))
  throw new Error("Invalid source origin");
const streams =
  roles.includes("stream") && origin
    ? new WorkerStreams(join(root, "streams"), origin)
    : undefined;
await streams?.initialize();
const catalog = new Catalog(join(root, "catalog.json"), blobs);
await catalog.initialize();
let instanceId;
try {
  instanceId = (await readFile(join(root, "instance-id"), "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  instanceId = randomUUID();
  await writeFile(join(root, "instance-id"), instanceId, {
    mode: 0o600,
    flag: "wx",
  });
}
const recordings = new RecordingIndex(join(root, "recordings.sqlite"), blobs);
const capacity = await new Capacity({
  maxStreams: process.env.HAUS_MAX_STREAMS
    ? Number(process.env.HAUS_MAX_STREAMS)
    : undefined,
}).initialize();
const detectors = roles.includes("stream")
  ? new Detectors(origin, capacity)
  : undefined;
await detectors?.initialize();
const playback = roles.includes("stream")
  ? new Playback(join(root, "playback"), blobs, capacity)
  : undefined;
await playback?.initialize();
const server = createNode({
  key,
  blobs,
  streams,
  catalog,
  recordings,
  instanceId,
  nodeId: process.env.HAUS_NODE_ID || hostname(),
  roles,
  maxStreams: capacity.streams,
  capacity,
  detectors,
  playback,
});
server.listen(Number(process.env.PORT || 8098), "0.0.0.0", () =>
  console.log("Haus NVR ready; pair this node with your Haus helper."),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  capacity.stop();
  await detectors?.stop();
  await playback?.stop();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    server.closeAllConnections();
  }, 3000);
  deadline.unref();
  await streams?.stop();
  await closed;
  clearTimeout(deadline);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
