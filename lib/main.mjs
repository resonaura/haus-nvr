import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname, release } from "node:os";
import { RecordingIndex } from "./recording-index.mjs";
import { Catalog } from "./catalog.mjs";
import { randomUUID } from "node:crypto";
import { WorkerStreams } from "./streams.mjs";
import { Blobs } from "./blobs.mjs";
import { createNode } from "./server.mjs";
import { Capacity } from "./capacity.mjs";
import { Detectors } from "./detectors.mjs";
import { Playback } from "./playback.mjs";
import { NodeSettings, storageLimitFromEnvironment } from "./settings.mjs";
import { HostTelemetry } from "./host-telemetry.mjs";
import { NativeCameraMedia } from "./native-camera-media.mjs";
import { CameraSessions } from "./camera-sessions.mjs";
import { CameraAccess } from "./camera-access.mjs";
import { CameraContinuity } from "./camera-continuity.mjs";
import { CameraRecordings } from "./camera-recordings.mjs";
import { CameraActivity } from "./camera-activity.mjs";
import { nodeRoles } from "./roles.mjs";
import { StorageBacking } from "./wsl-storage.mjs";
import {
  StorageUsage,
  nodeStorageCategory,
  addStorageRole,
} from "./storage-usage.mjs";
const root = resolve(process.env.HAUS_DATA || "/data");
await mkdir(root, { recursive: true, mode: 0o700 });
const key = (
  process.env.HAUS_NODE_KEY_FILE
    ? await readFile(process.env.HAUS_NODE_KEY_FILE, "utf8")
    : process.env.HAUS_NODE_KEY || ""
).trim();
const environmentLimit = storageLimitFromEnvironment(
  process.env.HAUS_MAX_STORAGE_GB,
);
const roles = nodeRoles(process.env.HAUS_ROLES);
let host;
const backing = new StorageBacking(join(root, "blobs"), () => host?.status(), {
  required:
    Boolean(process.env.HAUS_HOST_TELEMETRY_FILE) &&
    /microsoft|wsl/i.test(release()),
});
const workspaceBacking = new StorageBacking(root, () => host?.status(), {
  required:
    Boolean(process.env.HAUS_HOST_TELEMETRY_FILE) &&
    /microsoft|wsl/i.test(release()),
});
const blobs = new Blobs(join(root, "blobs"), {
  maxBytes: environmentLimit,
  backingCapacity: () => backing.capacity(),
  workspaceRoot: root,
  workspaceBackingCapacity: () => workspaceBacking.capacity(),
});
await blobs.initialize();
const settings = await new NodeSettings(join(root, "settings.json"), {
  environmentLimit,
  apply: (bytes, source) => blobs.setLimit(bytes, source),
}).initialize();
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
const cameraRecordings = roles.includes("stream")
  ? await new CameraRecordings(
      join(root, "camera-recordings"),
      recordings,
      blobs,
    ).initialize()
  : undefined;
const storageUsage = new StorageUsage({
  roots: [{ id: "data", path: root }],
  classify: () => {
    const roles = new Map();
    for (const backup of catalog.list())
      addStorageRole(
        roles,
        backup.digest,
        backup.kind === "ha" ? "ha-backups" : "config-backups",
      );
    for (const row of recordings.db
      .prepare("SELECT value FROM recordings")
      .iterate()) {
      const item = JSON.parse(row.value);
      if (item.storageVariant)
        addStorageRole(
          roles,
          item.digest,
          item.storageVariant === "prepared" ? "prepared" : "originals",
        );
      else if (item.playbackInfo?.originalCompatible === true)
        addStorageRole(roles, item.digest, "originals");
      addStorageRole(roles, item.originalDigest, "originals");
    }
    return (_root, path) => nodeStorageCategory(path, roles);
  },
});
const capacity = await new Capacity({
  maxStreams: process.env.HAUS_MAX_STREAMS
    ? Number(process.env.HAUS_MAX_STREAMS)
    : undefined,
}).initialize();
host = await new HostTelemetry({
  dataPath: root,
  capacity,
  collectorFile: process.env.HAUS_HOST_TELEMETRY_FILE,
  nativeServices: true,
}).initialize();
const detectors = roles.includes("stream")
  ? new Detectors(origin, capacity)
  : undefined;
await detectors?.initialize();
const playback = roles.includes("stream")
  ? new Playback(join(root, "playback"), blobs, capacity)
  : undefined;
await playback?.initialize();
const cameras = roles.includes("stream")
  ? await new CameraSessions(
      join(root, "camera-sessions"),
      new NativeCameraMedia(join(root, "camera-runtime"), {
        viewerLimit: Math.min(8, capacity.streams * 2),
      }),
      { capacity, blobs, max: capacity.streams, recordings: cameraRecordings },
    ).initialize()
  : undefined;
if (detectors) detectors.sessions = cameras;
const cameraAccess = cameras
  ? await new CameraAccess(join(root, "camera-access.enc"), key, cameras)
      .initialize()
      .catch(() => {
        console.warn(
          "Direct camera access is unavailable; existing media services remain active.",
        );
        return undefined;
      })
  : undefined;
const continuity = cameras
  ? await new CameraContinuity(
      join(root, "camera-continuity.enc"),
      key,
      cameras,
    )
      .initialize()
      .catch(() => {
        console.warn(
          "Camera continuity unavailable; existing media services remain active.",
        );
        return undefined;
      })
  : undefined;
const cameraActivity =
  cameras && detectors
    ? await new CameraActivity(
        join(root, "camera-activity.enc"),
        key,
        cameras,
        detectors,
      )
        .initialize()
        .catch(() => {
          console.warn(
            "Camera activity policy unavailable; existing media services remain active.",
          );
          return undefined;
        })
    : undefined;
const server = createNode({
  cameraActivity,
  cameraRecordings,
  continuity,
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
  settings,
  host,
  cameras,
  storageUsage,
  cameraAccess,
});
server.listen(Number(process.env.PORT || 8098), "0.0.0.0", () =>
  console.log("Haus server ready; connect this node to your home in Haus."),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  capacity.stop();
  host.stop();
  await storageUsage.stop();
  await continuity?.stop();
  await cameraActivity?.stop();
  await cameras?.stop();
  await cameraRecordings?.stop();
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
