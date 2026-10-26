## 0.3.35

- Reuse available media-test tools on CI runners. Install missing packages with bounded network timeouts/retries and an overall deadline, so a stalled package mirror cannot hold release validation indefinitely. Keep every test and both architecture image checks.
- Includes the Linux host CPU accounting correction from 0.3.34; no media, storage or runtime-policy changes.

## 0.3.34

- Use complete Linux host CPU counters for one-second and inventory samples. Keep I/O wait in elapsed time without counting it as processor work, and avoid double-counting guest time. Windows native metrics and container resource accounting retain their existing sources.
- Reset the CPU baseline when the counter source changes or Linux I/O-wait counters decrease; cover disk-heavy intervals, recovery/fallback and the displayed one-second telemetry path.

## 0.3.33

- Scope browser RTCP NACK retransmission to the requested media SSRC. Bundled audio/video feedback can share RTP sequence numbers; a request for one track must not replay the other track's cached packet. Keep bounded retransmission caches and leave other feedback untouched.
- Validate compound packet lengths and final-member padding before decoding feedback. Add a regression against the pinned production libdatachannel implementation and run it in both native image builds. No camera source, recording, retention or resource-policy changes.

# 0.3.31

## 0.3.32

- Bound recording/pre-event and playback scratch reservations by the actual working filesystem when archive blobs use a separate disk. Keep concurrent scratch reservations atomic and independent of uploads to another filesystem, while retaining media quotas and archive reserves.
- Report unavailable working-space capacity honestly and apply verified native backing limits to a separate sparse WSL workspace. Single-filesystem installations retain shared physical admission.
- Add full-disk, concurrent admission, release/recovery, archive-upload isolation and real Linux tmpfs regressions; exercise the actual cross-filesystem check in both image builds.

- Match the helper's 24-hour proven-silent audio-lead limit in playback admission. Legacy originals with about 30 seconds of video and 10–16 minutes of audio can require more than the former ten-minute trim allowance; rejecting those requests prevented bounded background preparation and archiving. The fixed profile still limits video to ten minutes, retains encoder/memory/output/time limits and preserves original bytes.
- Cover authenticated admission, out-of-range rejection and an actual media fixture whose 943.418-second silent lead is removed while its real tone survives. No live source, P2P, retention or quota policy changes.

# 0.3.27

- Report background per-component Haus file usage separately from disk capacity and quota admission. Measure logical size and allocated blocks, count hard links once, avoid following symlinks and report bounded/partial scans honestly. Preserve exact original/prepared catalog references; unclassified blobs remain explicit. No media processing, source, retention or quota changes.

# 0.3.22

- Declare CPU percentage units for each service provider. Query the Docker daemon OS instead of guessing from its client: Linux CLI stats use per-core units, Windows daemon CLI stats use whole-host units. PM2, systemd, native Windows process counters and launchd retain explicit per-core accounting. Preserve unknown units and whitelist the accounting field at the external-report boundary.

# 0.3.21

- Report bounded, read-only system service state and available resource counters from systemd, native Windows services (including WSL hosts) and the actual accessible launchd domain. Keep shared Windows process ownership explicit, preserve unknown counters and whitelist public identity/state/numeric fields only.

# Haus NVR changelog

## 0.3.20

- Sample live CPU/RAM/swap counters every second while keeping disk/service inventory on a slower path. A single warm Windows CIM reader avoids per-second PowerShell launches; stale/native-failure semantics remain intact.

- Prefer whole-Windows CPU, physical memory use, pagefile and boot uptime on native Windows and WSL collectors. Keep WSL service/runtime scope distinct and preserve native-sample freshness through transient query failure. Add `windows-resources.mjs` to standalone collector installations.

- Read native Windows installed RAM from summed `Win32_PhysicalMemory.Capacity` during the cached hardware refresh, including WSL collectors. Keep installed capacity separate from WSL's runtime limit and memory utilization; unknown module capacity remains unavailable.

## 0.3.19

- Read native Windows battery state through WSL with bounded queries and recent-sample caching. Keep active charging and connected external power separate, including a full battery on AC power.
- Preserve connected-power telemetry from Windows WMI, Linux power supplies and macOS power status through the host report sanitizer.
- Read installed Linux memory from SMBIOS module capacities or physical device-tree banks where available. Include `host-memory.mjs` when updating standalone collectors.

## 0.3.18

- Report the actual Windows host OS caption/version/build and all native display adapters separately from the WSL CPU/memory/process scope. Preserve a real Windows OS name for older clients while adding structured hardware metadata.
- Inventory every Linux PCI display-class function, including multiple integrated/discrete adapters, without guessing topology or VRAM from names. Do not expose serial numbers or the unreliable 32-bit Windows AdapterRAM value.
- Cache the bounded, read-only hardware inventory for one minute outside the media worker and viewer path. Missing permissions or optional tools remain unavailable and do not affect recording or physical-disk admission.

## 0.3.17

- Identify actual connection/media types from Linux block/udev metadata and native Windows Storage properties. Distinguish USB HDDs, explicitly reported SSDs or flash drives, SD/MMC and unknown solid-state USB without guessing from names. Export only allowlisted metadata and rebuild each sample for hot removal/reconnect.
- Prefer the modern Windows disk capacity alongside modern partition sizes; legacy CIM geometry can understate the physical device by several megabytes. Keep CIM as a capability fallback and never rescale contradictory source sizes to make them appear correct.
- Preserve all admission policies, native WSL backing protection, recordings and media workers. Optional collector updates need the new storage-media module alongside the existing collector files.

## 0.3.16

- Read actual Windows GPT partition metadata and hidden volume information: identify EFI System, Microsoft Reserved, recovery and data partitions, retain real partition numbers and measured FAT32/NTFS use without mounting a volume or assigning a drive letter. Keep the older CIM fallback when Storage cmdlets are unavailable.
- Preserve Linux GPT labels/purpose, actual partition numbers, device paths, mount aliases and read-only state. Recognize system/EFI/boot/data, swap, home and encryption/LVM/RAID from reported metadata, retaining unmounted partitions and unknown usage.
- Resolve the running WSL distribution's registered VHD and its actual Windows hosting volume through bounded read-only queries. Match the mounted data filesystem by device number; unrelated Windows disks never supply its admission budget.
- Bound new uploads and temporary media reservations by both Linux filesystem free space and fresh Windows backing free space, retaining the system reserve and user-selected Unlimited/custom policy. Debit committed growth until a newer native sample accounts for it, preventing repeated writes from reusing the same stale capacity.
- With a host collector configured on WSL, unavailable or stale backing data pauses new growth instead of trusting sparse logical free space. Existing originals/range reads remain available. Preserve Linux resource scope and omit the private VHD path from public telemetry.

## 0.3.15

- Let the optional host collector read native Windows disk/partition/volume relationships through fixed, read-only CIM selectors, including from WSL. Keep measured volume use and shared parents without duplicating storage capacity or treating sparse WSL devices as physical hardware.
- Preserve the Linux/WSL resource scope and expose its root filesystem separately. If Windows interoperability is absent, retain the existing truthful Linux fallback. After a successful native disk view, a short CIM interruption retains the last sample with its original freshness deadline.
- Bound CIM runtime/output, omit serial numbers and credentials, and keep collection outside the media request path. Existing worker resource limits, camera transport and storage policy are unchanged.

## 0.3.14

- Give large H264 keyframes enough paced burst capacity to reach WebRTC before its decoder's playout deadline. The previous low average-bitrate floor spread an 800-KiB picture across more than half a second, producing freezes and discarded dependent frames even with zero packet loss.
- Retain the bounded sender gate, media timestamps, encoded quality, audio pacing, adaptive upper cap and RTP buffering/NACK protections.
- Reproduce the failure with generated 2688×1520 multi-slice H264 and AAC: the same 20-second input previously decoded 131 frames with nine freezes / 12.227 seconds; the candidate decodes 405 frames with zero freezes/loss. Physical camera continuity remains a separate acceptance check.

## 0.3.13

- Grow a capture's temporary disk reservation in 16-MiB increments before copying encoded segments, instead of reserving 1 GiB for every short event. Reserve both segment copies and the output MP4, retain the 512-MiB per-file limit, and cap remux output to its admitted capacity.
- Reclaim partial capture files and reservations immediately on a capacity/copy failure, with bounded stage/reason diagnostics. Earlier saved originals, the warm producer and the system's free-space reserve remain protected.
- Reproduce three-camera admission under a 320-MiB shared budget and verify both incremental growth and refused growth. Existing actual-FFmpeg audio/pre-event and missing-footage checks remain in place.

## 0.3.12

- Anchor each pre-event reader's media clock once instead of treating every segment's close mtime as its media time. Disk/TCP write jitter must not fabricate gaps and reject otherwise complete audio/video recordings. Keep actual media gaps and independently anchored reader restarts visible.
- Release a failed finalization's disk reservation after its work directory is cleaned, and emit a bounded stage/reason diagnostic without source addresses or media data.
- Reproduce the former false rejection with actual FFmpeg audio/video segments and 800-ms file-write jitter. Require that the same recording succeeds while a truly missing interior segment still fails and never affects an earlier saved original. Verify stable mapping across polls and independent reader restart clocks.

## 0.3.11

- Preserve the browser's RTP sequence and media clocks when a local FFmpeg viewer reader reconnects with new random RTP origins. Keep source packet gaps/reordering intact and forward encoded payloads unchanged; the existing WebRTC/SRTP session can resume instead of remaining connected with a frozen picture.
- Count publisher changes separately from packet loss in bounded RTP diagnostics. A reconnect must not appear as thousands of missing packets.
- Add deterministic video/audio clock, sequence wrap, reordering and socket-ingress regressions. An isolated Chromium test reproduces the pre-fix freeze at 8.3 seconds after killing the reader; the fixed viewer resumes in the same peer with audio. Physical source corruption remains a separate open finding.

## 0.3.10

- Replay cached SPS/PPS and IDR slices at the same picture timestamp. Old parameter-set timestamps must not create a long synthetic gap before a late viewer’s first frame.
- Publish H264 readiness only after a complete bounded keyframe cache and both parameter sets are available, rather than on an orphan IDR tail. Preserve copied video/audio payloads and the existing fresh-keyframe gate.
- Extend the native regression with parameter sets nearly twenty seconds older than the picture and premature-readiness rejection. All 70 native-enabled tests pass locally; physical first-open acceptance remains separate.

## 0.3.9

- Cache every slice of an H264 IDR picture until the access-unit marker, and extract individual SPS/PPS NAL units from STAP-A packets for valid RTSP descriptions and clean first frames.
- Pace copied RTP packets instead of flooding browser receive queues with whole-frame bursts. Preserve payload quality and RTP clocks, and adapt the pacing budget for higher source bitrates.
- Emit regular RTCP sender reports with a shared audio/video CNAME and retain NACK recovery, so receivers can synchronize both media clocks.
- Add multi-slice cache, parameter-set and pacing regressions. Local generated H264/AAC media at 1280×720/20fps advances for twenty seconds with audio, zero lost packets and zero video freezes.

## 0.3.8

- Install native viewer tracks before applying the browser offer, disable automatic renegotiation, and explicitly generate an answer. Never send a replacement offer with an invalid `actpass` DTLS role as the viewer answer.
- Exercise repeated native browser-offer negotiations and require a valid answer role for every viewer.

## 0.3.7

- Preserve high-resolution RTP bursts with bounded receive buffers; expose effective buffer sizes, packet gaps, kernel drops and truncation counters separately for source and viewer ingestion.
- Keep a cached initial still while waiting for a clean live keyframe, so late viewers never attach a dependent frame to an incomplete prediction chain. Retain a bounded WebRTC retransmission history for packet-loss recovery.
- Preserve video and AAC RTP clock deltas across bursts and timestamp wraparound; do not inject PCMU silence into AAC streams.
- Finish partial interleaved TCP writes and disconnect stalled readers within a deadline instead of corrupting framing or indefinitely blocking source ingestion. Add native burst, late-reader and stalled-reader regression checks.

## 0.3.6

- Add a Haus-owned native RTSP relay and libdatachannel WebRTC viewer. Recording, the pre-event ring and live viewers share one continuously warmed RTSP producer; Aqara/Eufy sources remain explicit P2P RTSP restreams.
- Wait for ICE/DTLS before attaching a viewer reader, so its first packets come from the relay's cached keyframe. Add bounded source-reader recovery and sanitized camera startup, readiness and disconnect diagnostics.
- Build and exercise the native media worker in the image build; no go2rtc service or Home Assistant media conversion is used.

## 0.3.5

- Include the host operating system's distribution ID and display name in sanitized telemetry so Haus can identify Ubuntu and other Linux distributions automatically.
- Include read-only host battery level and charging state in telemetry for battery-backed servers.
