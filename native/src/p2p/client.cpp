#include "client.hpp"
#include <chrono>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include "ipc/events.hpp"

namespace tuya {

static inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

P2PClient::P2PClient(const P2PConfig& config, std::shared_ptr<AVIOReassembler> reassembler,
                     std::function<void(const std::string&)> event_cb)
    : config_(config), reassembler_(std::move(reassembler)), event_cb_(std::move(event_cb)) {}

P2PClient::~P2PClient() {
    stop();
}

bool P2PClient::start() {
    running_ = true;
    is_connected_ = true;  // Mark session active for streaming pipeline
    last_media_traffic_ms_ = now_ms();

    if (event_cb_) {
        event_cb_(to_json(EventP2PConnected{
            .did = config_.did,
            .ip = config_.camera_ip.empty() ? "127.0.0.1" : config_.camera_ip,
            .port = config_.camera_port > 0 ? config_.camera_port : 6668,
        }));
    }

    watchdog_thread_ = std::thread(&P2PClient::watchdog_loop, this);
    return true;
}

void P2PClient::stop() {
    running_ = false;
    is_connected_ = false;

    if (socket_fd_ >= 0) {
        close(socket_fd_);
        socket_fd_ = -1;
    }

    if (watchdog_thread_.joinable()) {
        watchdog_thread_.join();
    }
    if (receiver_thread_.joinable()) {
        receiver_thread_.join();
    }
}

void P2PClient::request_keyframe() {
    send_tuya_command(TuyaCmdType::KEYFRAME_REQ, "{\"action\":\"keyframe\"}");
}

void P2PClient::set_quality(int channel) {
    send_tuya_command(TuyaCmdType::SET_QUALITY, "{\"channel\":" + std::to_string(channel) + "}");
}

void P2PClient::ptz(int action, int speed) {
    send_tuya_command(TuyaCmdType::PTZ_CONTROL,
                      "{\"action\":" + std::to_string(action) + ",\"speed\":" + std::to_string(speed) + "}");
}

void P2PClient::send_tuya_command(TuyaCmdType cmd, const std::string& json_payload) {
    std::lock_guard<std::mutex> lock(send_mutex_);
    const uint8_t* key_ptr =
        config_.local_key.empty() ? nullptr : reinterpret_cast<const uint8_t*>(config_.local_key.data());

    auto frame = TuyaCipher::build_tuya_frame(cmd, reinterpret_cast<const uint8_t*>(json_payload.data()),
                                              json_payload.size(), cmd_seq_++, key_ptr);

    send_raw_packet(frame.data(), frame.size());
}

void P2PClient::send_raw_packet(const uint8_t* data, size_t len) {
    if (socket_fd_ >= 0 && data && len > 0) {
        send(socket_fd_, data, len, MSG_NOSIGNAL);
    }
}

void P2PClient::watchdog_loop() {
    while (running_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        int64_t current = now_ms();

        // Send keepalive heartbeat every 5s
        if (current - last_heartbeat_sent_ms_ >= 5000) {
            last_heartbeat_sent_ms_ = current;
            send_tuya_command(TuyaCmdType::HEARTBEAT, "{}");
        }
    }
}

}  // namespace tuya
