#pragma once

#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <map>
#include <mutex>
#include <rtc/rtc.hpp>
#include "media/reassembler.hpp"
#include "rtsp/server.hpp"

namespace tuya {

struct IceServerConfig {
    std::string url;
    std::string username;
    std::string password;
};

struct WebRTCConfig {
    std::string did;
    std::vector<IceServerConfig> ice_servers;
    bool is_hevc = false;
    std::string resolution = "hd";
};

class WebRTCPeer {
public:
    using EventCallback = std::function<void(const std::string&)>;
    using FrameCallback = std::function<void(const MediaFrame&)>;

    WebRTCPeer(const WebRTCConfig& config, std::shared_ptr<RTSPServer> rtsp_server, EventCallback event_cb);
    ~WebRTCPeer();

    bool start();
    void stop();

    void set_remote_description(const std::string& sdp, const std::string& type = "answer");
    void add_remote_candidate(const std::string& candidate, const std::string& mid = "");

    void request_keyframe();
    void set_quality(int channel);
    void ptz(int action, int speed);

    int get_talkback_port() const { return talkback_port_; }

private:
    void setup_peer_connection();
    void setup_tracks();
    void setup_data_channel();
    void send_data_channel_msg(const std::string& type, const std::string& msg = "");
    void keyframe_loop();
    void talkback_receive_loop(int socket_fd);
    void handle_video_packet(const rtc::binary& packet);
    void handle_audio_packet(const rtc::binary& packet);
    void handle_rtp_packet(const rtc::binary& packet, bool is_video);
    bool flush_reordered_packets(bool is_video, std::vector<std::vector<uint8_t>>& ready);

    WebRTCConfig config_;
    std::shared_ptr<RTSPServer> rtsp_server_;
    EventCallback event_cb_;

    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::Track> video_track_;
    std::shared_ptr<rtc::Track> audio_send_track_;
    std::shared_ptr<rtc::Track> audio_recv_track_;
    std::shared_ptr<rtc::DataChannel> data_channel_;

    int talkback_port_ = 0;
    int talkback_socket_fd_ = -1;
    uint32_t audio_send_ssrc_ = 0;
    uint16_t audio_send_seq_ = 1;
    uint32_t audio_send_ts_ = 0;
    std::thread talkback_receiver_thread_;

    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    std::atomic<bool> unhealthy_sent_{false};
    std::atomic<int64_t> last_video_packet_ms_{0};
    std::thread keyframe_thread_;
    std::mutex mutex_;

    struct RtpReorderState {
        bool initialized = false;
        uint16_t expected_seq = 0;
        std::map<uint16_t, std::vector<uint8_t>> pending;
    };
    std::mutex reorder_mutex_;
    RtpReorderState video_reorder_;
    RtpReorderState audio_reorder_;
};

}  // namespace tuya
