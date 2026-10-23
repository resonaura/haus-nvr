#pragma once

#include <string>
#include <glaze/glaze.hpp>

namespace tuya {

struct EventReady {
    std::string event = "ready";
};

struct EventPong {
    std::string event = "pong";
};

struct EventRelayStarted {
    std::string event = "relay_started";
    std::string did;
};

struct EventRelayReady {
    std::string event = "relay_ready";
    std::string did;
};

struct EventRelayReset {
    std::string event = "relay_reset";
    std::string did;
};

struct EventP2PConnected {
    std::string event = "p2p_connected";
    std::string did;
    std::string ip;
    int port = 0;
};

struct EventSessionReady {
    std::string event = "session_ready";
    std::string did;
};

struct EventSessionStarted {
    std::string event = "session_started";
    std::string did;
    int rtsp_port = 0;
    int talkback_port = 0;
};

struct EventSessionStopped {
    std::string event = "session_stopped";
    std::string did;
};

struct EventKeyframeRequested {
    std::string event = "request_keyframe";
    std::string did;
};

struct EventQualitySet {
    std::string event = "quality_set";
    std::string did;
    int channel = 0;
};

struct EventPTZExecuted {
    std::string event = "ptz_executed";
    std::string did;
};

struct EventUnhealthy {
    std::string event = "unhealthy";
    std::string did;
};

struct EventWebRTCOffer {
    std::string event = "webrtc_offer";
    std::string did;
    std::string sdp;
};

struct EventICECandidate {
    std::string event = "ice_candidate";
    std::string did;
    std::string candidate;
    std::string mid;
};

struct EventWebRTCConnected {
    std::string event = "webrtc_connected";
    std::string did;
};

struct EventWebRTCDisconnected {
    std::string event = "webrtc_disconnected";
    std::string did;
};

struct EventViewerOffer {
    std::string event = "viewer_offer";
    std::string viewer_id;
    std::string did;
    std::string sdp;
    int rtp_port = 0;
    int audio_rtp_port = 0;
};

struct EventViewerState {
    std::string event = "viewer_state";
    std::string viewer_id;
    std::string did;
    std::string state;
};

struct EventError {
    std::string event = "error";
    std::string did;
    std::string message;
    std::string viewer_id;
};

struct EventSnapshot {
    std::string event = "snapshot";
    std::string did;
    std::string data_base64;
};

template<typename T>
std::string to_json(const T& val) {
    std::string out;
    [[maybe_unused]] auto _ = glz::write_json(val, out);
    return out;
}

}  // namespace tuya
