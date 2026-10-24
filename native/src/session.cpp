#include <cstdlib>
#include <cstring>
#include <iostream>
#include "session.hpp"
#include "ipc/events.hpp"

namespace tuya {

StreamSession::StreamSession(const SessionConfig& config, std::function<void(const std::string&)> event_cb)
    : config_(config), event_cb_(std::move(event_cb)) {
    reassembler_ = std::make_shared<AVIOReassembler>();
    rtsp_server_ = std::make_shared<RTSPServer>(config_.rtsp_port, config_.rtsp_path, [this]() { request_keyframe(); });

    reassembler_->set_frame_callback([this](const MediaFrame& frame) {
        if (frame.is_video && frame.is_keyframe && !seen_first_keyframe_) {
            seen_first_keyframe_ = true;
            if (event_cb_)
                event_cb_(to_json(EventKeyframeRequested{.did = config_.did}));
        }

        if (rtsp_server_) {
            rtsp_server_->feed_frame(frame);
        }
    });

    WebRTCConfig wcfg;
    wcfg.did = config_.did;
    wcfg.ice_servers = config_.ice_servers;
    wcfg.resolution = (config_.p2p_quality_channel == 1) ? "sd" : "hd";

    webrtc_peer_ = std::make_unique<WebRTCPeer>(wcfg, rtsp_server_, event_cb_);
}

StreamSession::~StreamSession() {
    stop();
}

bool StreamSession::start() {
    if (!rtsp_server_->start()) {
        std::cerr << "[NativeSession] Failed to start RTSP server on port " << config_.rtsp_port << std::endl;
        return false;
    }

    if (webrtc_peer_) {
        webrtc_peer_->start();
    }

    std::cerr << "[NativeSession] Stream session active for " << config_.did
              << " rtsp=rtsp://0.0.0.0:" << config_.rtsp_port << "/" << config_.rtsp_path << std::endl;
    return true;
}

bool StreamSession::restart_p2p(const SessionConfig& new_cfg) {
    config_ = new_cfg;
    seen_first_keyframe_ = false;
    quality_switched_ = false;

    if (rtsp_server_) {
        rtsp_server_->clear_snapshot_annexb();
    }

    if (webrtc_peer_) {
        webrtc_peer_->stop();
        webrtc_peer_.reset();
    }

    WebRTCConfig wcfg;
    wcfg.did = config_.did;
    wcfg.ice_servers = config_.ice_servers;
    wcfg.resolution = (config_.p2p_quality_channel == 1) ? "sd" : "hd";

    std::cerr << "[NativeSession] Preserving RTSP server on port " << config_.rtsp_port
              << " while reconnecting WebRTC session for " << config_.did << std::endl;

    webrtc_peer_ = std::make_unique<WebRTCPeer>(wcfg, rtsp_server_, event_cb_);
    return webrtc_peer_->start();
}

void StreamSession::stop() {
    if (rtsp_server_) {
        rtsp_server_->clear_snapshot_annexb();
    }
    if (webrtc_peer_) {
        webrtc_peer_->stop();
    }
    if (p2p_client_) {
        p2p_client_->stop();
    }
    if (rtsp_server_) {
        rtsp_server_->stop();
    }
}

void StreamSession::set_remote_description(const std::string& sdp, const std::string& type) {
    if (webrtc_peer_) {
        webrtc_peer_->set_remote_description(sdp, type);
    }
}

void StreamSession::add_ice_candidate(const std::string& candidate, const std::string& mid) {
    if (webrtc_peer_) {
        webrtc_peer_->add_remote_candidate(candidate, mid);
    }
}

void StreamSession::request_keyframe() {
    if (webrtc_peer_)
        webrtc_peer_->request_keyframe();
    if (p2p_client_)
        p2p_client_->request_keyframe();
}

void StreamSession::set_quality(int channel) {
    if (webrtc_peer_)
        webrtc_peer_->set_quality(channel);
    if (p2p_client_)
        p2p_client_->set_quality(channel);
}

void StreamSession::ptz(int action, int speed) {
    if (webrtc_peer_)
        webrtc_peer_->ptz(action, speed);
    if (p2p_client_)
        p2p_client_->ptz(action, speed);
}

std::vector<uint8_t> StreamSession::get_snapshot_annexb() const {
    if (rtsp_server_)
        return rtsp_server_->get_latest_annexb();
    return {};
}

}  // namespace tuya
