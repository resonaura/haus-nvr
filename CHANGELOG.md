# Haus NVR changelog

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
