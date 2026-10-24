#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <rtc/rtc.hpp>

namespace tuya {

class BrowserPeer {
public:
    using EventCallback = std::function<void(const std::string&)>;

    BrowserPeer(std::string viewer_id, std::string did, EventCallback event_cb,
                std::vector<rtc::IceServer> ice_servers = {});
    ~BrowserPeer();

    bool start(const std::string& remote_offer);
    void stop();
    int rtp_port() const { return rtp_port_; }
    int audio_rtp_port() const { return audio_rtp_port_; }

private:
    void receive_loop(int socket_fd, bool is_video);

    std::string viewer_id_;
    std::string did_;
    EventCallback event_cb_;
    std::vector<rtc::IceServer> ice_servers_;
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::Track> video_track_;
    std::shared_ptr<rtc::Track> audio_track_;
    std::atomic<bool> running_{false};
    std::atomic<bool> answer_sent_{false};
    std::thread receiver_thread_;
    std::thread audio_receiver_thread_;
    std::thread answer_timer_thread_;
    std::mutex mutex_;
    std::mutex cand_mutex_;
    std::vector<std::string> local_candidates_;
    int socket_fd_ = -1;
    int audio_socket_fd_ = -1;
    int rtp_port_ = 0;
    int audio_rtp_port_ = 0;
    uint32_t ssrc_ = 0;
    uint32_t audio_ssrc_ = 0;
    uint8_t video_pt_ = 102;
    uint8_t audio_pt_ = 111;
};

}  // namespace tuya
