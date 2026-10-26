# Server telemetry and storage policy

Haus NVR 0.3.1 adds server telemetry without giving worker containers host management privileges. Pairing and media API protocol 1 remain compatible.

Whole disks, partitions, mapped storage containers and mounted volumes are reported separately. Linux LVM, encryption, RAID and multipath layers do not inflate the whole-disk count; APFS containers remain attached through their physical stores. Version 0.3.15 adds native Windows disk relationships, including through WSL interoperability. Sparse WSL filesystems remain separate from physical Windows capacity, and unknown physical status stays unknown.

## Monitoring without NVR

Version 0.3.33 can run solely as a Haus server-monitoring helper. Save `compose.monitoring.yaml`, create a unique key in `.env` with `HAUS_NODE_KEY`, and run `docker compose -f compose.monitoring.yaml up -d`. In Haus, open an SSH server’s Settings and choose **Connect monitoring**, or add a Haus Helper and leave both camera services off. Home Assistant requires Haus Helper 0.3.44 or later for monitoring-only connections.

An explicit empty `HAUS_ROLES` selects monitoring only. An omitted setting preserves the existing `storage,stream` default. Monitoring-only agents advertise no NVR roles or stream capacity and reject media, backup and storage routes even for authenticated clients. They retain a small identity/settings directory but start no camera sessions, detectors or playback workers. Haus polls their telemetry and schedules no media or recovery work on them.

The same optional host collector described below supplies the physical machine’s metrics without granting the container host command access. For monitoring, use `docker compose -f compose.monitoring.yaml -f compose.monitoring.host-telemetry.yaml up -d` after setting `HAUS_HOST_TELEMETRY_DIRECTORY`. Without that collector, the reported scope remains the container and unsupported host details stay unavailable. SSH and monitoring share a single device identity in Haus; saved SSH credentials never leave the desktop’s secure storage.

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

The collector uses Node OS counters, Linux `/proc` and `lsblk`, macOS `vm_stat`/`sysctl`/`diskutil`, or Windows read-only CIM queries. Host-scoped Linux samples include only the distribution ID and `PRETTY_NAME` from `/etc/os-release`, parsed as data and never evaluated as shell syntax. Linux/macOS/Windows include disk/partition/volume parents. APFS volume usage comes from its own allocation rather than repeating the entire container's used space. No process arguments, environments, labels, ports, Docker mounts, serial numbers, logs or command output appear in reports. PM2 metadata is reduced to an explicit status whitelist before writing. It does not start a stopped PM2 daemon.

On WSL, Windows PowerShell interoperability supplies the native Windows disk tree through `Win32_DiskDriveToDiskPartition` and `Win32_LogicalDiskToPartition`. Its capacities and volume usage are Windows measurements. New collectors additionally obtain native Windows resource counters as described below; when unavailable, the resource sample stays explicitly Linux/WSL rather than being relabeled. The WSL root filesystem appears separately with its logical capacity. Without interoperability/permissions, the collector retains Linux disk reporting. A transient failure after a native sample preserves the previous whole sample and timestamp, which expires normally after 30 seconds.

Version 0.3.16 additionally matches the exact running distribution from `wslpath`, its registered VHD file and its hosting Windows volume using read-only registry/volume queries. Only the distribution's filesystem device number and measured hosting-volume capacity are exported; the private image path and registry data are omitted. The worker matches this device number against its mounted data directory. New uploads and transient reservations use the lesser of Linux filesystem and Windows backing free space, then subtract the existing reserve/reservations. Committed writes remain debited until a newer native sample accounts for them. User quotas remain unchanged; Unlimited remains a policy choice, not a promise of unlimited physical capacity.

Version 0.3.17 reports optional connection, media, removable and hot-plug metadata. Linux reads fixed lsblk fields and allowlisted udev/kernel media properties; USB non-rotational storage stays generic solid-state unless a typed flag distinguishes flash or SSD. Windows joins native disk number and exact capacity before accepting a physical-media type. Storage names are never used as media evidence. Each collector sample replaces the inventory, so disconnected devices are not retained as connected. Install the complete `lib` collector dependency set, including `storage-media.mjs`, when updating a standalone collector.

Install the updated host collector before upgrading a WSL worker with `HAUS_HOST_TELEMETRY_FILE` configured: those installations require a verified post-start backing sample for new growth. Missing, stale, regressed or mismatched mapping reports zero allocatable backing capacity, while original reads and verification remain available. A separate data mount not belonging to the discovered distribution is not silently mapped to C:. It needs its own verified backing mapping before this guarded WSL configuration admits growth. Ordinary Linux/macOS/native-Windows workers do not gain a WSL requirement.

Docker status needs the host operator's existing Docker permission. Do not add the worker to the Docker group, mount `/var/run/docker.sock` into it, or expose an unauthenticated Docker API. Docker and PM2 failures are reported as unavailable; ordinary recording continues. The collector does not start, stop or restart host applications.

Run the collector under the same operator account that already runs the node/PM2. The output directory is created mode `0750` and the report `0640`. Give the worker UID/group read-only access to that sanitized directory (the official image uses UID/GID 1000), or configure a host ACL. Mount the **directory**, not an individual file: reports are replaced atomically.

```sh
# Add HAUS_HOST_TELEMETRY_DIRECTORY=/path/to/haus-telemetry to .env.
docker compose -f compose.yaml -f compose.host-telemetry.yaml up -d
```

The optional Compose override sets `HAUS_HOST_TELEMETRY_FILE=/host-telemetry/host.json` and a read-only directory mount. Existing `/data` and node settings remain unchanged. `deploy/haus-host-telemetry.service` is a systemd example; adjust its user, paths and directory ownership. On macOS, run the same command as a user LaunchAgent; on Windows, run it under the operator account at sign-in using Task Scheduler, mounting the output directory read-only through Docker Desktop. Windows service accounts see different PM2 homes than interactive users. If using PM2 on Windows, set `HAUS_PM2_CLI` to its JavaScript CLI entry file when it is not found automatically.

Samples refresh every second without overlapping. Each subprocess has a 2.5-second timeout (5 seconds for PM2 metadata on busy hosts; 8 seconds and 512 KiB for the Windows disk tree) and at most 1 MiB output. Arrays are limited to 128 disks and 256 service entries; reports are limited to 512 KiB. The worker caches samples outside the HTTP/media request path. A report older than 30 seconds, invalid or missing falls back to local container statistics, so stale host data cannot look current. Docker/PM2 availability can legitimately differ between host accounts.

## Host schema

```text
host: {
  sampledAt: ISO date,
  scope: "host" | "container",
  hostname, platform, distribution?, osName?, release, arch,
  metricsScope?: "windows" | "wsl", serviceScope?: "wsl",
  runtime?: {kind: "wsl", platform: "linux", release},
  uptimeSeconds, battery?: { level: 0..100 | null, charging: boolean | null } | null,
  storageBacking?: { source: "wsl-vhd", device: number, sampledAt: ISO date,
                     totalBytes, availableBytes, volume: "C:" | "Windows volume" },
  cpu: {model, logicalCores, usage: 0..1 | null, loadAverage: number[]},
  memory: {totalBytes, installedBytes?: number | null, availableBytes, usedBytes},
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

For Node OS counters, the first CPU sample has `usage: null`; the next supplies a delta over elapsed CPU time. Native Windows uses the formatted whole-host performance counter. Unknown metrics remain null. Docker CPU percentages may exceed 100% for multi-core containers; host `cpu.usage` is normalized over all available cores. No synthetic history is generated; clients can keep a bounded history of observed samples.

The coarse `kind` field remains compatible with older clients: only whole block disks use `disk`; other layers use `volume`. The additive `type` field identifies each layer precisely. `physical` is true only when available metadata identifies a physical disk, false for logical/virtual storage, and null when unconfirmed. A stable `parentId` supports existing tree views; `parentIds` preserves up to 16 parents for shared RAID/multipath/APFS/Windows storage without duplicating device rows. Windows supplies physical disks and their partitions/volumes; WSL fallback keeps its Linux resource identity; successfully queried whole-Windows counters carry the Windows host identity with separate WSL runtime metadata.

References: [Node OS counters](https://nodejs.org/api/os.html), [Windows CIM relationships](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-cimassociatedinstance), [Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/), [Docker container listing](https://docs.docker.com/reference/cli/docker/container/ls/), [PM2 process management](https://pm2.keymetrics.io/docs/usage/process-management/).

Version 0.3.18 keeps native host identity separate from the resource environment. On WSL, OS caption/version/build and graphics adapters come from bounded Windows CIM queries; CPU, RAM, swap, uptime and processes remain explicitly scoped to WSL. Linux graphics uses the actual PCI display-class inventory. Hardware refreshes once per minute in the host collector, not in media requests; missing permissions/tools remain unavailable. Windows AdapterRAM is not used because its 32-bit representation cannot reliably describe modern dedicated memory. Include `host-hardware.mjs` when updating standalone collectors.

Battery reports distinguish `charging` (active battery charging) from optional `powerConnected` (external power present). A full battery can have `charging=false` and `powerConnected=true`; clients keep the power bolt visible in that state. Windows queries active `root\wmi:BatteryStatus` rows, Linux checks online Mains/USB supplies, and macOS reads the current power source. Unknown power connection remains absent rather than inferred from the charge level. Refreshing a standalone collector requires `host-platform.mjs`, `host-telemetry.mjs` and their imported dependencies, including `host-memory.mjs`.

Windows resource telemetry works both from a native Windows collector and through WSL interoperability. The collector queries total-machine processor utilization/processor count, OS-visible physical memory use, allocated pagefile use and Windows boot uptime using fixed CIM selectors. These become the primary counters with `platform=win32` and `metricsScope=windows`; WSL service collection remains explicitly scoped with `serviceScope=wsl` and runtime metadata. Installed module capacity remains separate from OS-visible usable memory. Windows does not provide the Unix load-average values, so those stay unavailable. A failed refresh after native metrics became available retains the prior complete sample and its original freshness deadline; it never silently substitutes fresh WSL counters. An installation that has never supplied native counters may report an explicit WSL fallback. Include `windows-resources.mjs` when updating standalone collectors.

Live resource samples run at one-second cadence; disk/service inventory refreshes independently at ten seconds and hardware identity at sixty seconds. Windows uses one warm bounded CIM reader that exits when the collector closes its input pipe. Each native line has its own observation timestamp, so reading an unchanged cached line never makes it fresh. Collectors serialize samples instead of overlapping work on weak hosts.

System service inventory is reported separately from Docker and PM2. Linux uses fixed systemctl properties and CPU counter deltas; Windows uses fixed service/performance CIM properties and counts shared processes once. macOS reports the actual queried launchd domain. Missing counters remain null, and no command lines, account names, environments, or control operations are collected. Inventory remains on its existing bounded background cadence.

Service groups declare cpuPercentBasis as core or host (unknown is null). Linux Docker CLI, PM2 pidusage, systemd CPU deltas, Windows service process counters and macOS ps use core units. Windows Docker daemon CLI stats use host units. Docker discovery queries the daemon OSType; the CLI/collector OS is not evidence for this convention. Raw counters remain intact, allowing clients to normalize exactly once.

## Haus file usage

Authenticated status includes `storage.usage` (version 1). The first request starts a background scan; later requests receive a cached sample. Scans run at most once per 30 seconds, visit at most 100,000 entries and yield between I/O batches with a 3-second work deadline. This does not delay one-second host counters.

Only managed Haus data is inspected, using file metadata, never file contents or followed symbolic links. Categories distinguish confirmed originals/prepared video, backups, pre-event buffers, capture/preparation/stream caches, databases/logs and other measured files. Old recording roles are repaired from the helper's authoritative archive descriptors in bounded metadata-only batches. Missing roles remain Unclassified Media.

`logicalBytes` is unique-inode file size; `allocatedBytes` uses filesystem-reported 512-byte blocks and is null when unavailable. Hard links across categories appear once as Shared Files. Reflinks, compression and snapshots may share physical extents: allocated blocks are not a claim of exclusive hardware consumption. Directory/filesystem metadata, container images and external runtime logs are outside these managed-file totals. `complete: false` marks lower-bound scans after limits, I/O errors or concurrent disappearance. No personal paths, file contents, keys or blob identifiers appear in the usage response.
