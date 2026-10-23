#pragma once

#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <atomic>
#include <functional>
#include <mutex>
#include <netinet/in.h>
#include "protocol.hpp"
#include "cipher.hpp"
#include "media/reassembler.hpp"

namespace tuya {

struct P2PConfig {
    std::string did;
    std::string p2p_id;
    std::string init_string;
    std::string local_key;
    std::string token;
    std::string camera_ip;
    int camera_port = 6668;
    int p2p_quality_channel = 0;
};

class P2PClient {
public:
    P2PClient(const P2PConfig& config, std::shared_ptr<AVIOReassembler> reassembler,
              std::function<void(const std::string&)> event_cb);
    ~P2PClient();

    bool start();
    void stop();

    void request_keyframe();
    void set_quality(int channel);
    void ptz(int action, int speed = 50);

    bool is_connected() const { return is_connected_; }

private:
    void receiver_loop();
    void watchdog_loop();

    void send_tuya_command(TuyaCmdType cmd, const std::string& json_payload);
    void send_raw_packet(const uint8_t* data, size_t len);

    P2PConfig config_;
    std::shared_ptr<AVIOReassembler> reassembler_;
    std::function<void(const std::string&)> event_cb_;

    int socket_fd_ = -1;
    std::atomic<bool> running_{false};
    std::atomic<bool> is_connected_{false};
    std::atomic<int64_t> last_media_traffic_ms_{0};
    std::atomic<int64_t> last_heartbeat_sent_ms_{0};

    std::thread receiver_thread_;
    std::thread watchdog_thread_;

    uint32_t cmd_seq_ = 1;
    std::mutex send_mutex_;
};

}  // namespace tuya
