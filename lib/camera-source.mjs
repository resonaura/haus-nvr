import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const cameraId = (value) =>
  typeof value === "string" && /^camera\.[a-z0-9_]{1,120}$/.test(value);
export const ownerId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
export const privateIp = (value) =>
  isIP(value) === 4
    ? /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/.test(value)
    : isIP(value) === 6 &&
      (/^(?:fc|fd)[a-f0-9:]+$/i.test(value) || value === "::1");

/** Pin DNS once before passing the URL to a media engine. No engine directives or public inputs. */
export async function cameraSource(input, resolve = lookup) {
  if (
    !input ||
    !["p2p-restream", "rtsp"].includes(input.kind) ||
    typeof input.url !== "string" ||
    input.url.length > 4096
  )
    throw new Error("invalid_camera_source");
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("invalid_camera_source");
  }
  if (
    !["rtsp:", "rtsps:"].includes(url.protocol) ||
    url.hash ||
    /[\x00-\x20]/.test(input.url)
  )
    throw new Error("invalid_camera_source");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let deadline;
  const addresses = isIP(host)
    ? [{ address: host }]
    : await Promise.race([
        resolve(host, { all: true }),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("invalid_camera_source")),
            2500,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
  if (!addresses.length || addresses.some(({ address }) => !privateIp(address)))
    throw new Error("invalid_camera_source");
  url.hostname = addresses[0].address.includes(":")
    ? `[${addresses[0].address}]`
    : addresses[0].address;
  return { kind: input.kind, url: url.href };
}
