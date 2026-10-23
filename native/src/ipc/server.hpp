#pragma once

#include <string>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <atomic>
#include "session.hpp"
#include "webrtc/browser_peer.hpp"

namespace tuya {

class IpcServer {
public:
    IpcServer();
    ~IpcServer();

    void run_stdio();
    void send_event(const std::string& json_str);

private:
    void handle_command(const std::string& line);

    std::atomic<bool> running_{false};
    std::mutex cout_mutex_;
    std::mutex sessions_mutex_;
    std::unordered_map<std::string, std::unique_ptr<StreamSession>> sessions_;
    std::unordered_map<std::string, std::unique_ptr<BrowserPeer>> viewers_;
    std::unordered_map<std::string, std::shared_ptr<RTSPServer>> relays_;
};

}  // namespace tuya
