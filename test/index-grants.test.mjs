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
