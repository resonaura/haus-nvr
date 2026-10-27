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
  cameras,
  storageUsage,
  cameraAccess,
  continuity,
  cameraRecordings,
  cameraActivity,
}) {
  const authenticate = authenticator(key);
  let serving = 0;
  if (streams)
    streams.capacity = () =>
      capacity?.pressured
        ? 0
        : Math.max(0, maxStreams - (cameras?.sessions.size ?? 0));
  if (cameras) cameras.otherStreams = () => streams?.size ?? 0;
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
      if (
        roles.includes("stream") &&
        cameraAccess &&
        (await cameraAccess.handle(req, res, url.pathname))
      )
        return;
      const grant = verifyGrant(key, url);
      if (!grant && !authenticate(req))
        return json(res, 401, { error: "authentication_required" });
      const path = url.pathname;
      if (
        !grant &&
        roles.includes("stream") &&
        cameraActivity &&
        path === "/v1/camera-activity/trigger" &&
        req.method === "POST"
      )
        return json(
          res,
          200,
          await cameraActivity.trigger(await body(req, 4096)),
        );
      if (
        !grant &&
        roles.includes("stream") &&
        cameraActivity &&
        path === "/v1/camera-activity"
      ) {
        if (req.method === "GET")
          return json(res, 200, cameraActivity.status());
        if (req.method === "PUT")
          return json(
            res,
            200,
            await cameraActivity.update((await body(req, 300000)).cameras),
          );
      }
      if (!grant && roles.includes("stream") && cameraRecordings) {
        if (path === "/v1/camera-recordings" && req.method === "GET")
          return json(
            res,
            200,
            cameraRecordings.list(url.searchParams.get("cursor") ?? "0"),
          );
        const receipt = /^\/v1\/camera-recordings\/([a-f0-9-]{36})$/.exec(path);
        if (receipt && req.method === "GET") {
          const value = cameraRecordings.get(receipt[1]);
          return json(
            res,
            value ? 200 : 404,
            value ?? { error: "camera_recording_not_found" },
          );
        }
        if (receipt && req.method === "POST")
          return json(
            res,
            200,
            cameraRecordings.acknowledge(
              receipt[1],
              (await body(req, 4096)).sha256,
            ),
          );
      }
      if (
        !grant &&
        roles.includes("stream") &&
        continuity &&
        path === "/v1/camera-continuity" &&
        req.method === "PUT"
      )
        return json(
          res,
          200,
          await continuity.update((await body(req, 300000)).cameras),
        );
      if (
        !grant &&
        roles.includes("stream") &&
        cameraAccess &&
        path === "/v1/camera-access/reconcile" &&
        req.method === "POST"
      )
        return json(
          res,
          200,
          await cameraAccess.reconcile(await body(req, 16000)),
        );
      if (
        roles.includes("stream") &&
        cameraAccess &&
        path === "/v1/camera-access" &&
        req.method === "POST"
      )
        return json(
          res,
          201,
          await cameraAccess.provision(await body(req, 8192)),
        );
      const revokedAccess = /^\/v1\/camera-access\/([a-f0-9]{32})$/.exec(path);
      if (
        roles.includes("stream") &&
        cameraAccess &&
        revokedAccess &&
        req.method === "DELETE"
      )
        return json(res, 200, await cameraAccess.revoke(revokedAccess[1]));
      // A monitoring agent has no media or storage API, even with a valid key.
      if (!roles.length && path !== "/v1/status")
        return json(res, 404, { error: "not_found" });
      const verify = /^\/v1\/blobs\/([a-f0-9]{64})\/verify$/.exec(path);
      if (!grant && verify && req.method === "POST") {
        if (capacity?.pressured)
          return json(res, 503, { error: "verification_busy" });
        if (
          req.headers["x-haus-digest"] !== EMPTY_DIGEST ||
          Number(req.headers["content-length"] || 0) !== 0 ||
          req.headers["transfer-encoding"]
        )
          throw new Error("invalid_body");
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.on("close", cancel);
        req.on("aborted", cancel);
        try {
          return json(
            res,
            200,
            await blobs.verify(verify[1], { signal: abort.signal }),
          );
        } finally {
          res.off("close", cancel);
          req.off("aborted", cancel);
        }
      }
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
          features: {
            monitoringOnly: true,
            hostTelemetry: Boolean(host),
            directCameraAccess: Boolean(
              roles.includes("stream") && cameraAccess,
            ),
            cameraAccessPolicy:
              roles.includes("stream") && cameraAccess ? 1 : 0,
            cameraContinuity: roles.includes("stream") && continuity ? 1 : 0,
            cameraRecordingRecovery:
              roles.includes("stream") && cameraRecordings ? 1 : 0,
            autonomousCameraActivity:
              roles.includes("stream") && cameraActivity ? 1 : 0,
          },
          relayOrigin: streams?.origin,
          storage: {
            ...(await blobs.status()),
            ...(storageUsage ? { usage: storageUsage.status() } : {}),
          },
          ...(settings ? { settings: settings.status() } : {}),
          ...(host ? { host: host.status() } : {}),
          streams: {
            active: streams?.size ?? 0,
            max:
              !roles.includes("stream") || capacity?.pressured ? 0 : maxStreams,
          },
          media: {
            active: serving,
            max: roles.length ? Math.max(4, maxStreams * 2) : 0,
          },
          ...(capacity ? { resources: capacity.status() } : {}),
          ...(detectors ? { detectors: detectors.status() } : {}),
          ...(playback ? { playback: playback.status() } : {}),
          ...(cameras ? { rtspSessions: cameras.status() } : {}),
          ...(continuity ? { cameraContinuity: continuity.status() } : {}),
          ...(cameraActivity
            ? { cameraActivity: cameraActivity.status() }
            : {}),
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
      if (!grant && cameras && (await cameras.handle(req, res, path))) return;
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
          if (cameraRecordings?.pending(id)) throw Error("blob_in_use");
          await blobs.remove(id);
          await catalog?.remove(id);
          recordings?.remove(id);
          return json(res, 200, { deleted: true });
        }
        if (["GET", "HEAD"].includes(req.method)) {
          let reader;
          try {
            reader = await blobs.openRead(id);
          } catch {
            return json(res, 404, { error: "media_not_found" });
          }
          try {
            const info = reader.info;
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
            res.setTimeout(30000, () => res.destroy());
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
                reader.stream({ start: range.start, end: range.end }),
                res,
              );
            } finally {
              serving--;
            }
            return;
          } finally {
            await reader.close();
          }
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const message = String(error.message);
      const verificationCodes = {
        media_not_found: 404,
        blob_changed: 409,
        blob_in_use: 409,
        digest_mismatch: 400,
        verification_busy: 503,
        verification_timeout: 504,
        camera_session_not_found: 404,
        camera_recording_not_found: 404,
        camera_recording_not_ready: 409,
        camera_ring_not_ready: 409,
        camera_session_busy: 503,
        camera_recording_busy: 503,
        camera_viewer_busy: 503,
        camera_session_unavailable: 503,
        camera_engine_unavailable: 503,
        camera_engine_timeout: 503,
        camera_media_failed: 503,
        camera_stream_warming: 503,
        camera_webrtc_failed: 503,
      };
      // A verification digest mismatch is persisted corruption, not a bad upload.
      const status =
        /^\/v1\/blobs\/[a-f0-9]{64}\/verify$/.test(
          new URL(req.url, "http://node.invalid").pathname,
        ) && message === "digest_mismatch"
          ? 409
          : verificationCodes[message];
      json(
        res,
        status ??
          (/^(invalid_|digest_|body_)/.test(message)
            ? 400
            : /storage_full|busy/.test(message)
              ? 507
              : 503),
        {
          error:
            status ||
            /^(invalid_|digest_|body_|storage_full|transfer_busy)/.test(message)
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
    void cameras?.stop();
    void cameraActivity?.stop();
    if (cameraRecordings)
      void cameraRecordings.stop().finally(() => recordings?.close());
    else recordings?.close();
  });
  return server;
}
