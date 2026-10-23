# Server telemetry and storage policy (Haus NVR 0.3.3)

Haus NVR 0.3.1 adds server telemetry without giving worker containers host management privileges. Pairing and media API protocol 1 remain compatible.

Version 0.3.3 separates whole disks, partitions, mapped storage containers and mounted volumes. Linux LVM, encryption, RAID and multipath layers no longer inflate the whole-disk count; APFS containers remain attached through their physical stores. Virtual/WSL disks do not claim physical hardware, and unknown physical status stays unknown.

## Storage policy

New nodes have no fixed storage quota. Unset, empty or `0` `HAUS_MAX_STORAGE_GB` means unlimited. An explicitly supplied positive environment value remains the initial limit on upgraded installations. A user change in Haus takes precedence, survives restarts in `/data/settings.json`, and can deliberately remove an old environment limit.

Unlimited still keeps a 512 MiB free-space reserve, two concurrent uploads, verified checksums, bounded encoder output and a 16 GiB per-file transfer ceiling. Work is admitted against physical free space and any configured node quota. Reducing a quota never removes existing recordings or backup copies and does not cancel a transfer that was already admitted. New copies wait until space becomes available. Retention/deletion remains the helper's responsibility.

Authenticated APIs use the existing timestamped HMAC signature and request-body SHA-256:

```json
GET /v1/settings
{"storageLimitBytes":null,"source":"default"}

PATCH /v1/settings
{"storageLimitBytes":53687091200}

{"storageLimitBytes":53687091200,"source":"user"}
```

Only `storageLimitBytes`, a positive safe integer in bytes or `null`, is accepted. Updates are serialized and atomically persisted before being acknowledged. Source is `default`, `environment` or `user`.

`GET /v1/status` includes `settings` with the same response, and storage:

- `storageLimitBytes`: configured quota or `null` for unlimited.
- `limitSource`: policy source.
- `usedBytes`, `reservedBytes`, `activeTransfers`: verified files and in-flight reservations.
- `totalBytes`, `freeBytes`, `reserveBytes`: the actual data filesystem and safety reserve.
- `availableBytes`: remaining allocatable space after both quota and free-space reserve, less pending reservations.
- `maxBytes`: finite effective capacity for older helpers; minimum of the configured quota and `usedBytes + freeBytes - reserveBytes`. It is not a configured quota when `storageLimitBytes` is `null`.

## What a worker can see

Authenticated status includes a cached `host` sample. Container-only installations honestly report `scope: "container"`, effective CPU/RAM quotas, container swap limits when available and the mounted Haus data volume. The existing `resources` object continues to control scheduling independently of host telemetry. A native installation reports its host.

To show real host disks, Docker and PM2 while running the node in Docker, run the optional collector **on the actual host**, not inside the worker:

```sh
# Node.js 24+, from the haus-nvr checkout. No dependencies required.
node lib/host-collector.mjs --output /path/to/haus-telemetry/host.json
# One read-only sample for diagnostics:
node lib/host-collector.mjs --output /path/to/haus-telemetry/host.json --once
```

The collector uses Node OS counters, Linux `/proc` and `lsblk`, macOS `vm_stat`/`sysctl`/`diskutil`, or Windows read-only CIM queries. Host-scoped Linux samples include only the distribution ID and `PRETTY_NAME` from `/etc/os-release`, parsed as data and never evaluated as shell syntax. Linux/macOS include disk/partition/volume parents; Windows includes local fixed volumes. APFS volume usage comes from its own allocation rather than repeating the entire container's used space. No process arguments, environments, labels, ports, Docker mounts, logs or command output appear in reports. PM2 metadata is reduced to an explicit status whitelist before writing. It does not start a stopped PM2 daemon.

Docker status needs the host operator's existing Docker permission. Do not add the worker to the Docker group, mount `/var/run/docker.sock` into it, or expose an unauthenticated Docker API. Docker and PM2 failures are reported as unavailable; ordinary recording continues. The collector does not start, stop or restart host applications.

Run the collector under the same operator account that already runs the node/PM2. The output directory is created mode `0750` and the report `0640`. Give the worker UID/group read-only access to that sanitized directory (the official image uses UID/GID 1000), or configure a host ACL. Mount the **directory**, not an individual file: reports are replaced atomically.

```sh
# Add HAUS_HOST_TELEMETRY_DIRECTORY=/path/to/haus-telemetry to .env.
docker compose -f compose.yaml -f compose.host-telemetry.yaml up -d
```

The optional Compose override sets `HAUS_HOST_TELEMETRY_FILE=/host-telemetry/host.json` and a read-only directory mount. Existing `/data` and node settings remain unchanged. `deploy/haus-host-telemetry.service` is a systemd example; adjust its user, paths and directory ownership. On macOS, run the same command as a user LaunchAgent; on Windows, run it under the operator account at sign-in using Task Scheduler, mounting the output directory read-only through Docker Desktop. Windows service accounts see different PM2 homes than interactive users. If using PM2 on Windows, set `HAUS_PM2_CLI` to its JavaScript CLI entry file when it is not found automatically.

Samples refresh every five seconds without overlapping. Each subprocess has a 2.5-second timeout (5 seconds for PM2 metadata on busy hosts) and at most 1 MiB output. Arrays are limited to 128 disks and 256 service entries; reports are limited to 512 KiB. The worker caches samples outside the HTTP/media request path. A report older than 30 seconds, invalid or missing falls back to local container statistics, so stale host data cannot look current. Docker/PM2 availability can legitimately differ between host accounts.

## Host schema

```text
host: {
  sampledAt: ISO date,
  scope: "host" | "container",
  hostname, platform, distribution?, osName?, release, arch,
  uptimeSeconds, battery?: { level: 0..100 | null, charging: boolean | null } | null,
  cpu: {model, logicalCores, usage: 0..1 | null, loadAverage: number[]},
  memory: {totalBytes, availableBytes, usedBytes},
  swap: {supported, totalBytes: number | null, usedBytes: number | null},
  disks: [{id, name, kind: "disk" | "volume",
           type: "disk" | "partition" | "container" | "volume",
           physical: boolean | null, parentId: string | null, parentIds: string[],
           mountpoint: string | null, filesystem: string | null,
           totalBytes, usedBytes: number | null, availableBytes: number | null, scope}],
  docker: {available, source: "local" | "host-collector" | "unavailable",
           containers: [{id, name, image, state, status, cpuPercent: number | null,
                         memoryUsedBytes: number | null, memoryLimitBytes: number | null}]},
  pm2: {available, source: "local" | "host-collector" | "unavailable",
        processes: [{id, name, status, pid, cpuPercent: number | null,
                     memoryBytes: number | null, uptimeSeconds: number | null,
                     restarts: number | null}]}
}
```

The first native CPU sample has `usage: null`; the next supplies a delta over elapsed CPU time. Unknown metrics remain null. Docker CPU percentages may exceed 100% for multi-core containers; host `cpu.usage` is normalized over all available cores. No synthetic history is generated; clients can keep a bounded history of observed samples.

The coarse `kind` field remains compatible with older clients: only whole block disks use `disk`; other layers use `volume`. The additive `type` field identifies each layer precisely. `physical` is true only when available metadata identifies a physical disk, false for logical/virtual storage, and null when unconfirmed. A stable `parentId` supports existing tree views; `parentIds` preserves up to 16 parents for shared RAID/multipath/APFS storage without duplicating device rows. Native Windows reports fixed volumes; WSL remains Linux telemetry with its WSL kernel release and virtual disk status.

References: [Node OS counters](https://nodejs.org/api/os.html), [Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/), [Docker container listing](https://docs.docker.com/reference/cli/docker/container/ls/), [PM2 process management](https://pm2.keymetrics.io/docs/usage/process-management/).
