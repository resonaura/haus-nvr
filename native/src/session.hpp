#pragma once

#include <string>
#include <memory>
#include <functional>
#include "p2p/client.hpp"
#include "webrtc/peer.hpp"
#include "media/reassembler.hpp"
#include "rtsp/server.hpp"

namespace tuya {

struct SessionConfig {
    std::string did;
    std::string p2p_id;
    std::string init_string;
    std::string local_key;
    std::string token;
    std::string camera_ip;
    int camera_port = 0;
    int rtsp_port = 8554;
    std::string rtsp_path;
    int p2p_quality_channel = 0;
    std::vector<IceServerConfig> ice_servers;
};

class StreamSession {
public:
    StreamSession(const SessionConfig& config, std::function<void(const std::string&)> event_cb);
    ~StreamSession();

    bool start();
    bool restart_p2p(const SessionConfig& new_cfg);
    void stop();

    void set_remote_description(const std::string& sdp, const std::string& type = "answer");
    void add_ice_candidate(const std::string& candidate, const std::string& mid = "");

    void request_keyframe();
    void set_quality(int channel);
    void ptz(int action, int speed = 50);

    std::vector<uint8_t> get_snapshot_annexb() const;

    int get_talkback_port() const { return webrtc_peer_ ? webrtc_peer_->get_talkback_port() : 0; }

    const std::string& get_did() const { return config_.did; }

private:
    SessionConfig config_;
    std::function<void(const std::string&)> event_cb_;

    std::shared_ptr<AVIOReassembler> reassembler_;
    std::shared_ptr<RTSPServer> rtsp_server_;
    std::unique_ptr<P2PClient> p2p_client_;
    std::unique_ptr<WebRTCPeer> webrtc_peer_;
    bool seen_first_keyframe_ = false;
    bool quality_switched_ = false;
};

}  // namespace tuya
