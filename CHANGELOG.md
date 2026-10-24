# Haus NVR changelog

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
