#include <cstdlib>
#include <iostream>
#include <glaze/glaze.hpp>
#include "server.hpp"
#include "events.hpp"

namespace tuya {

static std::string base64_encode(const uint8_t* data, size_t len) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    while (i + 2 < len) {
        uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out.push_back(tbl[(n >> 18) & 0x3F]);
        out.push_back(tbl[(n >> 12) & 0x3F]);
        out.push_back(tbl[(n >> 6) & 0x3F]);
        out.push_back(tbl[n & 0x3F]);
        i += 3;
    }
    if (i + 1 == len) {
        uint32_t n = data[i] << 16;
        out.push_back(tbl[(n >> 18) & 0x3F]);
        out.push_back(tbl[(n >> 12) & 0x3F]);
        out.push_back('=');
        out.push_back('=');
    } else if (i + 2 == len) {
        uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
        out.push_back(tbl[(n >> 18) & 0x3F]);
        out.push_back(tbl[(n >> 12) & 0x3F]);
        out.push_back(tbl[(n >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

struct IceServerDto {
    std::string url;
    std::string username;
    std::string password;
};

struct IpcCommandDto {
    std::string cmd;
    std::string did;
    std::string p2p_id;
    std::string init_string;
    std::string local_key;
    std::string token;
    std::string camera_ip;
    int camera_port = 0;
    int rtsp_port = 8554;
    int rtp_port = 0;
    int audio_rtp_port = 0;
    std::string rtsp_path;
    int p2p_quality_channel = 0;
    std::vector<IceServerDto> ice_servers;
    std::string sdp;
    std::string type;
    std::string candidate;
    std::string mid;
    int channel = 0;
    std::string direction;
    std::string viewer_id;
    int action = 0;
    int speed = 50;
};

IpcServer::IpcServer() = default;

IpcServer::~IpcServer() {
    running_ = false;
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    viewers_.clear();
    relays_.clear();
    sessions_.clear();
}

void IpcServer::send_event(const std::string& json_str) {
    std::lock_guard<std::mutex> lock(cout_mutex_);
    std::cout << json_str << "\n" << std::flush;
}

void IpcServer::run_stdio() {
    running_ = true;
    send_event(to_json(EventReady{}));

    std::string line;
    while (running_ && std::getline(std::cin, line)) {
        if (line.empty())
            continue;
        handle_command(line);
    }
}

void IpcServer::handle_command(const std::string& line) {
    IpcCommandDto cmd_dto;
    auto ec = glz::read_json(cmd_dto, line);
    if (ec) {
        send_event(to_json(EventError{.did = "", .message = "JSON parse error: " + glz::format_error(ec, line)}));
        return;
    }

    const std::string& cmd = cmd_dto.cmd;

    if (cmd == "ping") {
        send_event(to_json(EventPong{}));
    } else if (cmd == "start_session" || cmd == "start_p2p") {
        SessionConfig cfg;
        cfg.did = cmd_dto.did;
        cfg.p2p_id = cmd_dto.p2p_id;
        cfg.init_string = cmd_dto.init_string;
        cfg.local_key = cmd_dto.local_key;
        cfg.token = cmd_dto.token;
        cfg.camera_ip = cmd_dto.camera_ip;
        cfg.camera_port = cmd_dto.camera_port;
        cfg.rtsp_port = cmd_dto.rtsp_port > 0 ? cmd_dto.rtsp_port : 8554;
        cfg.rtsp_path = cmd_dto.rtsp_path.empty() ? ("live/" + cfg.did) : cmd_dto.rtsp_path;
        cfg.p2p_quality_channel = cmd_dto.p2p_quality_channel;

        for (const auto& ice : cmd_dto.ice_servers) {
            cfg.ice_servers.push_back({
                .url = ice.url,
                .username = ice.username,
                .password = ice.password,
            });
        }

        if (cfg.did.empty()) {
            send_event(to_json(EventError{.did = "", .message = "Missing did in start_session"}));
            return;
        }

        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cfg.did);
        if (it != sessions_.end()) {
            if (it->second->restart_p2p(cfg)) {
                send_event(to_json(EventSessionStarted{
                    .did = cfg.did,
                    .rtsp_port = cfg.rtsp_port,
                    .talkback_port = it->second->get_talkback_port(),
                }));
            } else {
                send_event(to_json(EventError{.did = cfg.did, .message = "Failed to restart P2P session"}));
            }
            return;
        }

        auto session = std::make_unique<StreamSession>(cfg, [this](const std::string& evt) { send_event(evt); });

        if (session->start()) {
            int tb_port = session->get_talkback_port();
            sessions_[cfg.did] = std::move(session);
            send_event(to_json(EventSessionStarted{
                .did = cfg.did,
                .rtsp_port = cfg.rtsp_port,
                .talkback_port = tb_port,
            }));
        } else {
            send_event(to_json(EventError{.did = cfg.did, .message = "Failed to start session"}));
        }
    } else if (cmd == "start_relay") {
        if (cmd_dto.did.empty() || cmd_dto.rtsp_port <= 0 || cmd_dto.rtp_port <= 0 ||
            cmd_dto.audio_rtp_port <= 0) {
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "Invalid relay configuration"}));
            return;
        }
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        relays_.erase(cmd_dto.did);
        auto relay = std::make_shared<RTSPServer>(cmd_dto.rtsp_port, cmd_dto.rtsp_path, nullptr, false, true);
        relay->set_media_ready_callback([this, did = cmd_dto.did]() {
            send_event(to_json(EventRelayReady{.did = did}));
        });
        if (!relay->start() || !relay->start_udp_ingest(cmd_dto.rtp_port, cmd_dto.audio_rtp_port)) {
            relay->stop();
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "Failed to start H264 relay"}));
            return;
        }
        relays_[cmd_dto.did] = std::move(relay);
        send_event(to_json(EventRelayStarted{.did = cmd_dto.did}));
    } else if (cmd == "stop_relay") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        relays_.erase(cmd_dto.did);
    } else if (cmd == "reset_relay") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = relays_.find(cmd_dto.did);
        if (it != relays_.end()) {
            it->second->notify_video_discontinuity();
            send_event(to_json(EventRelayReset{.did = cmd_dto.did}));
        } else {
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "Relay not found"}));
        }
    } else if (cmd == "start_viewer") {
        std::cerr << "[IPC] Received start_viewer for did=" << cmd_dto.did << " viewer_id=" << cmd_dto.viewer_id
                  << " sdp_len=" << cmd_dto.sdp.size() << std::endl;
        if (cmd_dto.viewer_id.empty() || cmd_dto.did.empty() || cmd_dto.sdp.empty()) {
            std::cerr << "[IPC] Missing viewer_id, did, or sdp!" << std::endl;
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "Missing viewer_id, did, or browser offer", .viewer_id = cmd_dto.viewer_id}));
            return;
        }
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        viewers_.erase(cmd_dto.viewer_id);
        std::vector<rtc::IceServer> ice_servers;
        for (const auto& ice : cmd_dto.ice_servers) {
            rtc::IceServer srv(ice.url);
            if (!ice.username.empty()) {
                srv.username = ice.username;
                srv.password = ice.password;
            }
            ice_servers.push_back(srv);
        }
        auto viewer = std::make_unique<BrowserPeer>(
            cmd_dto.viewer_id, cmd_dto.did, [this](const std::string& evt) { send_event(evt); }, ice_servers);
        if (!viewer->start(cmd_dto.sdp)) {
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "Failed to start browser WebRTC viewer", .viewer_id = cmd_dto.viewer_id}));
            return;
        }
        viewers_[cmd_dto.viewer_id] = std::move(viewer);
    } else if (cmd == "stop_viewer") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        viewers_.erase(cmd_dto.viewer_id);
    } else if (cmd == "set_remote_answer" || cmd == "set_remote_description") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->set_remote_description(cmd_dto.sdp, cmd_dto.type.empty() ? "answer" : cmd_dto.type);
        }
    } else if (cmd == "add_ice_candidate") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->add_ice_candidate(cmd_dto.candidate, cmd_dto.mid);
        }
    } else if (cmd == "request_keyframe") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->request_keyframe();
            send_event(to_json(EventKeyframeRequested{.did = cmd_dto.did}));
        }
    } else if (cmd == "set_quality") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->set_quality(cmd_dto.channel);
            send_event(to_json(EventQualitySet{.did = cmd_dto.did, .channel = cmd_dto.channel}));
        }
    } else if (cmd == "ptz") {
        int action = 0;
        if (cmd_dto.direction == "up")
            action = 1;
        else if (cmd_dto.direction == "down")
            action = 2;
        else if (cmd_dto.direction == "left")
            action = 3;
        else if (cmd_dto.direction == "right")
            action = 4;
        else
            action = cmd_dto.action;

        int speed = cmd_dto.speed > 0 ? cmd_dto.speed : 50;

        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->ptz(action, speed);
            send_event(to_json(EventPTZExecuted{.did = cmd_dto.did}));
        }
    } else if (cmd == "stop_session" || cmd == "stop_p2p") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        sessions_.erase(cmd_dto.did);
        send_event(to_json(EventSessionStopped{.did = cmd_dto.did}));
    } else if (cmd == "get_snapshot") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            auto annexb = it->second->get_snapshot_annexb();
            if (!annexb.empty()) {
                std::string b64 = base64_encode(annexb.data(), annexb.size());
                send_event(to_json(EventSnapshot{.did = cmd_dto.did, .data_base64 = b64}));
            } else {
                send_event(to_json(EventError{.did = cmd_dto.did, .message = "snapshot annexb not ready"}));
            }
        } else {
            send_event(to_json(EventError{.did = cmd_dto.did, .message = "no active session"}));
        }
    } else if (cmd == "exit") {
        running_ = false;
    }
}

}  // namespace tuya
