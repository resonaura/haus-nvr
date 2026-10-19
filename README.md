<p align="center"><img src="assets/icon.png" width="128" alt="Haus" /></p>
<h1 align="center">Haus NVR</h1>
<p align="center">A little more room for your home.</p>
<p align="center">Optional storage and streaming nodes for the Haus Home Assistant helper.</p>

Haus works with one Home Assistant helper. Add NVR nodes when you want more places to keep recordings, a separate machine to serve media, or recovery copies outside your HA host. The helper stays in charge; worker nodes never receive its Home Assistant token.

## What it does

- Stores verified, content-addressed recordings and encrypted configuration/HA recovery archives.
- Serves seekable media directly to Haus using a two-minute, read-only capability for one file. Pairing keys stay between the helper and the worker.
- Optionally relays live HLS through FFmpeg using a narrowly scoped helper source. Live relay is separate from normal recording playback.
- Keeps a local recording index and backup catalog, so useful recovery metadata remains available if the helper is lost.
- Enforces disk budgets, free-space reserves, transfer/concurrency limits, stream idle timeouts and temporary-file cleanup.
- Uses one Linux image for x86-64 and ARM64. Docker runs as an unprivileged user, with a read-only root filesystem and no additional capabilities.

This is an early release. Prebuilt images are published at `ghcr.io/resonaura/haus-nvr:0.1.1` for Linux x86-64 and ARM64. Requires Haus helper 0.2.1 or later; no worker is required for normal local recording.

## Start a node

Requires Docker Compose and persistent storage. Copy `compose.yaml` to the node, then create a unique pairing key:

```sh
umask 077
printf 'HAUS_NODE_KEY=%s\n' "$(openssl rand -hex 32)" > .env
docker compose pull
docker compose up -d
```

Open **Haus → Settings → Storage, streaming & backups → Add node**. Enter its address, name and the value of `HAUS_NODE_KEY` from `.env`. Keep that key private and use a different one for each node.

Use HTTPS through your trusted reverse proxy for transport privacy. HTTP must be explicitly enabled when pairing and is limited to private addresses. HTTP does not encrypt video in transit; backup payloads are always encrypted before leaving the helper. Do not expose a plain HTTP node port to the internet.

Configure `HAUS_MAX_STORAGE_GB` and `HAUS_NODE_ID` in Compose. `HAUS_ROLES` accepts `storage`, `stream`, or both. Every paired node receives encrypted recovery copies; storage nodes also receive video. The helper keeps the original video and normally places up to two worker copies, preferring existing placements and available disk. Pausing/removing a node never deletes the helper's originals.

There is no configured node-count limit. Helper health checks have bounded concurrency, each node has its own storage/stream budgets, and the Haus node list is virtualized. More nodes do not remove network or hardware capacity limits.

## Optional live relay

Normal recording streaming needs no inbound helper port. For a live relay only:

1. Enable the helper's optional private source port in the HA add-on network settings.
2. Set the node's `HAUS_SOURCE_ORIGIN` to that helper address, for example `http://192.168.1.10:8099`. Add the variable under `environment` in Compose.
3. Restart the node, then add/reconnect it in Haus.

The helper issues a camera-specific, expiring source capability. It rewrites HLS references and restricts every upstream request to that camera's HA HLS prefix. The worker receives neither a general HA token nor permission to browse HA APIs. Video remains behind authenticated worker endpoints. A relay stops after idle, on source expiry, or when its spool budget is exceeded. Camera audio is received only as part of the chosen stream; this does not open a microphone.

## Backups and recovery

The helper creates Haus configuration snapshots hourly and after settled layout/node/detector changes and, by default, daily HA configuration/app backups. It retains 24 Haus snapshots and 7 HA backups, and copies each to every connected node. Offline nodes catch up. The HA archive includes HA, apps, SSL, share and local-app configuration; camera media is excluded. The helper's own backup/buffer directories are excluded from HA app archives to avoid recursive backups. Its live SQLite database is backed up through a consistent snapshot hook.

Use **Save recovery kit** in Haus and keep that JSON file offline. It contains the decryption key and node access keys; workers never receive the decryption key. Losing both the helper's key and your recovery kit makes encrypted archives unrecoverable. Video on worker storage is not encrypted by this application; use host disk encryption if required.

With Node.js 24, list and export a backup without applying it:

```sh
node lib/recover.mjs --kit /safe/haus-recovery.json --node NODE_ID --list
node lib/recover.mjs --kit /safe/haus-recovery.json --node NODE_ID \
  --digest SHA256_FROM_LIST --output /safe/verified-backup.tar
# Recover a recording using the node's independent index:
node lib/recover.mjs --kit /safe/haus-recovery.json --node NODE_ID --list-recordings
node lib/recover.mjs --kit /safe/haus-recovery.json --node NODE_ID \
  --recording EVENT_ID --output /safe/verified-recording.mp4
```

Recording listings are paginated; pass `--cursor` with `nextCursor` to inspect an earlier page.

The command verifies the file checksum and AES-GCM authentication before producing the archive. It never overwrites an existing output, extracts an archive or restores HA automatically. A Haus archive contains `haus.sqlite`, `options.json` and `backup.key`. Stop the helper before deliberately restoring those files. Import HA archives through HA's normal backup restore flow. Existing scenes/devices are never changed by exporting a backup.

## Development

```sh
npm test
# Full helper/worker contract test from adjacent local checkouts:
HAUS_HELPER_PATH=/absolute/path/haus-helper/haus-helper \
  node --test test/integration/helper.test.mjs
```

The tests run local HTTP nodes, signed uploads and range reads, damaged-file checks, disk/accounting checks, an actual FFmpeg live relay, and a three-node helper scenario with worker disk replacement. They do not access household cameras or lighting.

Tag builds are prepared for `linux/amd64` and `linux/arm64` in GitHub Actions, with provenance and SBOM output. No registry push occurs on pull requests.

References: [HA backup API](https://contributors.home-assistant.io/apps/supervisor-api/backups/), [HA app backup configuration](https://contributors.home-assistant.io/apps/reference/configuration/), [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2).

For a node on a separate host, provision HTTPS before ordinary pairing. The opt-in remote protocol test accepts `HAUS_NVR_TEST_URL` and `HAUS_NVR_TEST_KEY_FILE`; run it against a disposable node, because it uploads and removes a synthetic fixture recording.
