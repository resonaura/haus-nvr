# Haus NVR changelog

## 0.3.6

- Add a Haus-owned native RTSP relay and libdatachannel WebRTC viewer. Recording, the pre-event ring and live viewers share one continuously warmed RTSP producer; Aqara/Eufy sources remain explicit P2P RTSP restreams.
- Wait for ICE/DTLS before attaching a viewer reader, so its first packets come from the relay's cached keyframe. Add bounded source-reader recovery and sanitized camera startup, readiness and disconnect diagnostics.
- Build and exercise the native media worker in the image build; no go2rtc service or Home Assistant media conversion is used.

## 0.3.5

- Include the host operating system's distribution ID and display name in sanitized telemetry so Haus can identify Ubuntu and other Linux distributions automatically.
- Include read-only host battery level and charging state in telemetry for battery-backed servers.
