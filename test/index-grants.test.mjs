import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordingIndex } from "../lib/recording-index.mjs";
import { mediaGrant, verifyGrant } from "../lib/grants.mjs";
test("a media capability expires, cannot change file, and contains no pairing key", () => {
  const key = "pairing-key-that-never-enters-the-renderer",
    digest = "a".repeat(64),
    now = Date.now(),
    grant = mediaGrant(key, digest, now);
  assert.ok(!grant.path.includes(key));
  assert.equal(
    verifyGrant(key, new URL(grant.path, "http://node"), now),
    digest,
  );
  assert.equal(
    verifyGrant(key, new URL(grant.path, "http://node"), now + 120001),
    null,
  );
  assert.equal(
    verifyGrant(
      key,
      new URL(grant.path.replace(digest, "b".repeat(64)), "http://node"),
      now,
    ),
    null,
  );
});
test("recording cursor pagination does not lose equal-time clips", async () => {
  const index = new RecordingIndex(":memory:", {
    info: async () => ({ size: 10 }),
  });
  try {
    for (let i = 0; i < 201; i++)
      await index.add({
        digest: "a".repeat(64),
        event: {
          id: i.toString(16).padStart(36, "0"),
          cameraId: "camera.fixture",
          startAt: 1000,
          endAt: 2000,
          duration: 1,
          kinds: ["motion"],
          playbackVersion: 2,
        },
      });
    const first = index.list(),
      last = index.list(first.nextCursor);
    assert.equal(first.items.length, 200);
    assert.equal(last.items.length, 1);
    assert.equal(
      new Set([...first.items, ...last.items].map((item) => item.id)).size,
      201,
    );
    assert.equal(last.nextCursor, null);
    assert.throws(() => index.list("not-a-cursor"));
  } finally {
    index.close();
  }
});

test("storage references preserve exact original/prepared roles without accepting arbitrary metadata", async () => {
  const index = new RecordingIndex(":memory:", {
    info: async () => ({ size: 10 }),
  });
  const event = {
    id: "a".repeat(36),
    cameraId: "camera.fixture",
    startAt: 1000,
    endAt: 2000,
    duration: 1,
    kinds: [],
  };
  const input = {
    event,
    digest: "b".repeat(64),
    variant: "prepared",
    originalDigest: "c".repeat(64),
  };
  try {
    await index.add(input);
    assert.equal(index.get(event.id).originalDigest, input.originalDigest);
    assert.equal(index.get(event.id).storageVariant, "prepared");
    await assert.rejects(
      index.add({ ...input, originalDigest: "not-a-digest" }),
      /invalid_recording_metadata/,
    );
    await assert.rejects(
      index.add({ ...input, variant: "guess" }),
      /invalid_recording_metadata/,
    );
  } finally {
    index.close();
  }
});
test("replicates corrected playback timing and bounded repair diagnostics", async () => {
  const index = new RecordingIndex(":memory:", {
    info: async () => ({ size: 10 }),
  });
  try {
    await index.add({
      digest: "a".repeat(64),
      event: {
        id: "a".repeat(36),
        cameraId: "camera.fixture",
        startAt: 1000,
        endAt: 3000,
        duration: 2,
        originalDuration: 1002,
        kinds: ["motion"],
        playbackVersion: 3,
        playbackInfo: {
          audio: true,
          duration: 2,
          audioTrimSeconds: 1000,
          audioTailSeconds: -1,
          sourceGaps: Array(100).fill({ at: 1, duration: 2 }),
          privateField: "omitted",
        },
      },
    });
    const item = index.get("a".repeat(36));
    assert.equal(item.originalDuration, 1002);
    assert.deepEqual(item.playbackInfo, {
      audio: true,
      duration: 2,
      audioTrimSeconds: 1000,
    });
  } finally {
    index.close();
  }
});
test("archive catalog preserves explicit original compatibility/provenance without trusting legacy packet versions", async () => {
  const index = new RecordingIndex(":memory:", {
    info: async () => ({ size: 10 }),
  });
  const base = {
    id: "a".repeat(36),
    cameraId: "camera.fixture",
    startAt: 1000,
    endAt: 2000,
    duration: 1,
    kinds: ["motion"],
    playbackVersion: 4,
  };
  try {
    await index.add({
      digest: "a".repeat(64),
      event: {
        ...base,
        playbackInfo: {
          originalCompatible: false,
          originalPolicyVersion: 1,
          compatibilityRepaired: true,
          originalProvenance: {
            kind: "camera",
            platform: "mqtt",
            manufacturer: "Aqara",
            model: "G5 Pro",
            token: "do-not-copy",
          },
        },
      },
    });
    assert.deepEqual(index.get(base.id).playbackInfo, {
      originalCompatible: false,
      originalPolicyVersion: 1,
      compatibilityRepaired: true,
      originalProvenance: {
        kind: "camera",
        platform: "mqtt",
        manufacturer: "Aqara",
        model: "G5 Pro",
      },
    });
    await index.add({
      digest: "a".repeat(64),
      event: { ...base, playbackInfo: { audio: true } },
    });
    assert.deepEqual(index.get(base.id).playbackInfo, { audio: true });
    await index.add({
      digest: "a".repeat(64),
      event: {
        ...base,
        playbackInfo: {
          originalCompatible: true,
          originalPolicyVersion: 1,
          originalProvenance: {
            kind: "haus-encoder",
            profile: 1,
            encoderArgs: "do-not-copy",
          },
        },
      },
    });
    assert.deepEqual(index.get(base.id).playbackInfo, {
      originalCompatible: true,
      originalPolicyVersion: 1,
      originalProvenance: { kind: "haus-encoder", profile: 1 },
    });
  } finally {
    index.close();
  }
});
test("archive provenance rejects unknown policies/profiles and bounds camera labels", async () => {
  const index = new RecordingIndex(":memory:", {
    info: async () => ({ size: 10 }),
  });
  const base = {
    id: "a".repeat(36),
    cameraId: "camera.fixture",
    startAt: 1000,
    endAt: 2000,
    duration: 1,
    kinds: ["motion"],
  };
  try {
    await index.add({
      digest: "a".repeat(64),
      event: {
        ...base,
        playbackInfo: {
          originalCompatible: "true",
          originalPolicyVersion: 2,
          compatibilityRepaired: 1,
          originalProvenance: { kind: "haus-encoder", profile: 99 },
        },
      },
    });
    assert.deepEqual(index.get(base.id).playbackInfo, {});
    await index.add({
      digest: "a".repeat(64),
      event: {
        ...base,
        playbackInfo: {
          originalProvenance: {
            kind: "camera",
            manufacturer: "\0" + "a".repeat(300),
            platform: 42,
            model: "Camera\nModel",
          },
        },
      },
    });
    assert.deepEqual(index.get(base.id).playbackInfo, {
      originalProvenance: {
        kind: "camera",
        manufacturer: "a".repeat(160),
        model: "CameraModel",
      },
    });
  } finally {
    index.close();
  }
});
