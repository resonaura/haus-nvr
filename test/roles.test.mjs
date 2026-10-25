import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeRoles } from "../lib/roles.mjs";

test("monitoring is explicit while an omitted setting preserves existing NVR roles", () => {
  assert.deepEqual(nodeRoles(undefined), ["storage", "stream"]);
  assert.deepEqual(nodeRoles(""), []);
  assert.deepEqual(nodeRoles("  "), []);
  assert.deepEqual(nodeRoles("stream, storage,stream"), ["stream", "storage"]);
  for (const input of [null, [], "monitor", "storage,", "storage,other"])
    assert.throws(() => nodeRoles(input), /Invalid roles/);
});
