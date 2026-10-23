import { mediaGrant, verifyGrant } from "./grants.mjs";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { authenticator, EMPTY_DIGEST } from "./auth.mjs";
import { parseRange } from "./blobs.mjs";
import { json, body } from "./http.mjs";
export function createNode({
  key,
  blobs,
  streams,
  catalog,
  recordings,
  nodeId,
  instanceId,
  roles = ["storage", "stream"],
  maxStreams = 4,
  capacity,
  detectors,
  playback,
  settings,
  host,
}) {
  const authenticate = authenticator(key);
  let serving = 0;
  if (streams) streams.capacity = () => (capacity?.pressured ? 0 : maxStreams);
  const server = createServer(async (req, res) => {
    try {
      if (
        req.url === "/health" &&
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        )
      )
        return json(res, 200, { status: "ok" });
      const url = new URL(req.url, "http://node.invalid");
      const grant = verifyGrant(key, url);
      if (!grant && !authenticate(req))
        return json(res, 401, { error: "authentication_required" });
      const path = url.pathname;
      if (!grant && settings && path === "/v1/settings") {
        if (req.method === "GET") return json(res, 200, settings.status());
        if (req.method === "PATCH")
          return json(res, 200, await settings.update(await body(req, 4096)));
      }
      if (!grant && path === "/v1/grants" && req.method === "POST") {
        const input = await body(req);
        await blobs.info(input.digest);
        return json(res, 201, mediaGrant(key, input.digest));
      }
      if (req.method === "GET" && path === "/v1/status")
        return json(res, 200, {
          protocol: 1,
          nodeId,
          instanceId,
          roles,
          relayOrigin: streams?.origin,
          storage: await blobs.status(),
          ...(settings ? { settings: settings.status() } : {}),
          ...(host ? { host: host.status() } : {}),
          streams: {
            active: streams?.size ?? 0,
            max: capacity?.pressured ? 0 : maxStreams,
          },
          media: { active: serving, max: Math.max(4, maxStreams * 2) },
          ...(capacity ? { resources: capacity.status() } : {}),
          ...(detectors ? { detectors: detectors.status() } : {}),
          ...(playback ? { playback: playback.status() } : {}),
        });
      if (!grant && catalog && path === "/v1/backups") {
        if (req.method === "GET")
          return json(res, 200, { items: catalog.list() });
        if (req.method === "POST") {
          await catalog.add(await body(req));
          return json(res, 201, { saved: true });
        }
      }
      if (!grant && recordings && path === "/v1/recordings") {
        if (req.method === "GET") {
          return json(
            res,
            200,
            recordings.list(url.searchParams.get("cursor") || undefined),
          );
        }
        if (req.method === "POST") {
          await recordings.add(await body(req));
          return json(res, 201, { saved: true });
        }
      }
      if (
        !grant &&
        recordings &&
        /^\/v1\/recordings\/[a-f0-9-]{36}$/.test(path) &&
        req.method === "GET"
      ) {
        const item = recordings.get(path.split("/").at(-1));
        return json(res, item ? 200 : 404, item ?? { error: "not_found" });
      }
      if (streams && (await streams.handle(req, res, path))) return;
      if (!grant && detectors && (await detectors.handle(req, res, path)))
        return;
      if (!grant && playback && (await playback.handle(req, res, path))) return;
      const match = grant
        ? [null, grant]
        : /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(path);
      if (match) {
        const id = match[1];
        if (grant && !["GET", "HEAD"].includes(req.method))
          return json(res, 403, { error: "read_only_grant" });
        if (req.method === "PUT") {
          if (req.headers["x-haus-digest"] !== id)
            throw new Error("digest_mismatch");
          const result = await blobs.put(
            id,
            req,
            Number(req.headers["content-length"]),
          );
          if (result.existing) req.resume();
          return json(res, result.existing ? 200 : 201, { digest: id });
        }
        if (!grant && req.headers["x-haus-digest"] !== EMPTY_DIGEST)
          throw new Error("invalid_body");
        if (req.method === "DELETE") {
          await blobs.remove(id);
          await catalog?.remove(id);
          recordings?.remove(id);
          return json(res, 200, { deleted: true });
        }
        if (["GET", "HEAD"].includes(req.method)) {
          let info;
          try {
            info = await blobs.info(id);
          } catch {
            return json(res, 404, { error: "media_not_found" });
          }
          let range;
          try {
            range = parseRange(req.headers.range, info.size);
          } catch {
            return res
              .writeHead(416, { "Content-Range": `bytes */${info.size}` })
              .end();
          }
          if (req.method === "GET" && serving >= Math.max(4, maxStreams * 2))
            return json(res, 503, { error: "stream_busy" });
          res.writeHead(range.partial ? 206 : 200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": range.end - range.start + 1,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
            ...(range.partial
              ? {
                  "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
                }
              : {}),
          });
          if (req.method === "HEAD") return res.end();
          serving++;
          try {
            await pipeline(
              blobs.stream(id, { start: range.start, end: range.end }),
              res,
            );
          } finally {
            serving--;
          }
          return;
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const message = String(error.message);
      json(
        res,
        /^(invalid_|digest_|body_)/.test(message)
          ? 400
          : /storage_full|busy/.test(message)
            ? 507
            : 503,
        {
          error: /^(invalid_|digest_|body_|storage_full|transfer_busy)/.test(
            message,
          )
            ? message
            : "node_unavailable",
        },
      );
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.on("close", () => {
    host?.stop();
    void detectors?.stop();
    void streams?.stop();
    recordings?.close();
  });
  return server;
}
