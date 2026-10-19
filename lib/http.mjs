import { createHash } from "node:crypto";
export const json = (res, status, value) =>
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(value));
export async function body(req, max = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    req.headers["x-haus-digest"]
  )
    throw new Error("digest_mismatch");
  return JSON.parse(bytes.toString());
}
