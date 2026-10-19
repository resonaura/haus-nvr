import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const signature = (key, digest, expires, nonce) =>
  createHmac("sha256", key)
    .update(["media", digest, expires, nonce].join("\n"))
    .digest("hex");
export function mediaGrant(key, digest, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_digest");
  const expires = String(now + 120000),
    nonce = randomBytes(16).toString("hex");
  return {
    path: `/media/${digest}?expires=${expires}&nonce=${nonce}&signature=${signature(key, digest, expires, nonce)}`,
    expiresAt: Number(expires),
  };
}
export function verifyGrant(key, url, now = Date.now()) {
  const match = /^\/media\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return null;
  const expires = url.searchParams.get("expires"),
    nonce = url.searchParams.get("nonce"),
    sig = url.searchParams.get("signature");
  if (
    !/^\d{13}$/.test(expires) ||
    Number(expires) < now ||
    Number(expires) > now + 120000 ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return null;
  const expected = signature(key, match[1], expires, nonce);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
    ? match[1]
    : null;
}
