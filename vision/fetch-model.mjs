import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(
  await readFile(new URL("./model.json", import.meta.url), "utf8"),
);
const response = await fetch(manifest.url, {
  signal: AbortSignal.timeout(120000),
});
if (!response.ok) throw new Error("Vision model download failed");
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
  throw new Error("Vision model digest mismatch");
await writeFile(new URL("./model.onnx", import.meta.url), bytes);
