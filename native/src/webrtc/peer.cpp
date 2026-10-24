#include "peer.hpp"
#include <arpa/inet.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <regex>
#include <sys/socket.h>
#include <unistd.h>
#include <glaze/glaze.hpp>
#include "ipc/events.hpp"

namespace tuya {

WebRTCPeer::WebRTCPeer(const WebRTCConfig& config, std::shared_ptr<RTSPServer> rtsp_server, EventCallback event_cb)
    : config_(config), rtsp_server_(std::move(rtsp_server)), event_cb_(std::move(event_cb)) {}

WebRTCPeer::~WebRTCPeer() {
    stop();
}

bool WebRTCPeer::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (running_)
        return true;
    running_ = true;

    auto bind_receiver = [](int& socket_fd, int& port) {
        socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (socket_fd < 0)
            return false;

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        if (bind(socket_fd, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) < 0) {
            close(socket_fd);
            socket_fd = -1;
            return false;
        }

        socklen_t addr_len = sizeof(addr);
        if (getsockname(socket_fd, reinterpret_cast<sockaddr*>(&addr), &addr_len) != 0) {
            close(socket_fd);
            socket_fd = -1;
            return false;
        }
        port = ntohs(addr.sin_port);
        int recv_buffer = 2 * 1024 * 1024;
        setsockopt(socket_fd, SOL_SOCKET, SO_RCVBUF, &recv_buffer, sizeof(recv_buffer));
        return true;
    };

    if (bind_receiver(talkback_socket_fd_, talkback_port_)) {
        std::cerr << "[WebRTCPeer] 🎙️ Talkback UDP ingest listening on 127.0.0.1:" << talkback_port_ << " for "
                  << config_.did << std::endl;
        talkback_receiver_thread_ = std::thread(&WebRTCPeer::talkback_receive_loop, this, talkback_socket_fd_);
    }

    setup_peer_connection();

    keyframe_thread_ = std::thread(&WebRTCPeer::keyframe_loop, this);
    return true;
}

void WebRTCPeer::stop() {
    running_ = false;
    connected_ = false;

    if (talkback_socket_fd_ >= 0) {
        shutdown(talkback_socket_fd_, SHUT_RDWR);
        close(talkback_socket_fd_);
        talkback_socket_fd_ = -1;
    }
    if (talkback_receiver_thread_.joinable()) {
        talkback_receiver_thread_.join();
    }

    if (keyframe_thread_.joinable()) {
        keyframe_thread_.join();
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (data_channel_) {
        try {
            data_channel_->close();
        } catch (...) {
        }
        data_channel_.reset();
    }

    if (video_track_) {
        try {
            video_track_->close();
        } catch (...) {
        }
        video_track_.reset();
    }

    if (audio_send_track_) {
        try {
            audio_send_track_->close();
        } catch (...) {
        }
        audio_send_track_.reset();
    }

    if (audio_recv_track_) {
        try {
            audio_recv_track_->close();
        } catch (...) {
        }
        audio_recv_track_.reset();
    }

    if (pc_) {
        try {
            pc_->close();
        } catch (...) {
        }
        pc_.reset();
    }
}

void WebRTCPeer::talkback_receive_loop(int socket_fd) {
    std::array<std::byte, 2048> buffer{};
    uint64_t packet_count = 0;
    while (running_) {
        const auto len = recv(socket_fd, buffer.data(), buffer.size(), 0);
        if (len <= 0) {
            if (running_)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }
        if (len < static_cast<ssize_t>(sizeof(rtc::RtpHeader)))
            continue;

        auto* header = reinterpret_cast<rtc::RtpHeader*>(buffer.data());
        if (header->version() != 2)
            continue;
        // Keep PT 0 (PCMU) / 8 (PCMA) / 10 (L16). Tuya WebRTC advertises G.711
        // but this camera's own packets are 640-byte PCM16 (2 bytes/sample).
        uint8_t pt = header->payloadType();
        if (pt != 8 && pt != 0 && pt != 10 && pt != 11) {
            header->setPayloadType(0);
            pt = 0;
        }
        header->setSsrc(audio_send_ssrc_);
        header->setSeqNumber(audio_send_seq_++);
        header->setTimestamp(audio_send_ts_);
        const size_t payload_bytes = len > 12 ? static_cast<size_t>(len - 12) : 0;
        // On this camera, audio played through speaker has two modes:
        // - 640-byte raw PCM16: 320 samples @ 8 kHz -> 40 ms (ts increment = 320)
        // - 160-byte DAC μ-law: 160 bytes * 2 ticks = 320 samples @ 8 kHz -> 40 ms (ts increment = 320)
        // In general, 1 byte of DAC μ-law plays as 2 samples at 8 kHz (sample_increment = payload_bytes * 2).
        const uint32_t sample_increment = (payload_bytes >= 640) ? static_cast<uint32_t>(payload_bytes / 2)
                                                                 : static_cast<uint32_t>(payload_bytes * 2);
        audio_send_ts_ += (sample_increment > 0 ? sample_increment : 320);

        std::lock_guard<std::mutex> lock(mutex_);
        if (!audio_send_track_ || !audio_send_track_->isOpen()) {
            if (packet_count % 100 == 0) {
                std::cerr << "[WebRTCPeer] ⚠️ Audio send track not open yet (isOpen="
                          << (audio_send_track_ ? audio_send_track_->isOpen() : false)
                          << ", state=" << (pc_ ? static_cast<int>(pc_->state()) : -1) << ")" << std::endl;
            }
            packet_count++;
            continue;
        }

        try {
            audio_send_track_->send(buffer.data(), static_cast<size_t>(len));
            packet_count++;
            if (packet_count == 1 || packet_count % 100 == 0) {
                std::cerr << "[WebRTCPeer] 🎙️ Sent " << packet_count << " talkback audio packets to camera "
                          << config_.did << " (len=" << len << ", ssrc=" << audio_send_ssrc_ << ")" << std::endl;
            }
        } catch (const std::exception& e) {
            std::cerr << "[WebRTCPeer] ❌ Failed to send talkback audio: " << e.what() << std::endl;
        }
    }
}

void WebRTCPeer::keyframe_loop() {
    int seconds = 0;
    while (running_) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (!running_)
            break;
        ++seconds;
        const auto now =
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
                .count();
        const auto last = last_video_packet_ms_.load();

        if (connected_) {
            if (last > 0 && now - last > 5000 && !unhealthy_sent_.exchange(true)) {
                if (event_cb_)
                    event_cb_(to_json(EventUnhealthy{.did = config_.did}));
            }
            // If packets have completely halted for > 15 seconds, connection is dead
            if (last > 0 && now - last > 15000) {
                std::cerr << "[WebRTCPeer] ⚠️ RTP packets stalled for >15s, forcing WebRTC disconnect for " << config_.did << std::endl;
                connected_ = false;
                if (rtsp_server_) {
                    rtsp_server_->clear_snapshot_annexb();
                }
                if (event_cb_) {
                    event_cb_(to_json(EventWebRTCDisconnected{.did = config_.did}));
                }
            }
            if (seconds >= 10) {
                seconds = 0;
                request_keyframe();
            }
        } else {
            // Disconnected: keep keyframe cache empty
            if (rtsp_server_) {
                rtsp_server_->clear_snapshot_annexb();
            }
        }
    }
}

void WebRTCPeer::handle_video_packet(const rtc::binary& packet) {
    if (packet.empty())
        return;
    const auto now =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
            .count();
    last_video_packet_ms_ = now;
    unhealthy_sent_ = false;
    handle_rtp_packet(packet, true);
}

void WebRTCPeer::handle_audio_packet(const rtc::binary& packet) {
    if (packet.size() < 12 || !rtsp_server_)
        return;
    handle_rtp_packet(packet, false);
}

void WebRTCPeer::handle_rtp_packet(const rtc::binary& packet, bool is_video) {
    if (packet.size() < 12 || !rtsp_server_)
        return;

    const auto* bytes = reinterpret_cast<const uint8_t*>(packet.data());

    // Strict RTP validation:
    // 1. Version must be 2 (top 2 bits == 10)
    if ((bytes[0] >> 6) != 2)
        return;

    const uint8_t pt = bytes[1] & 0x7F;
    // 2. RFC 5761: PT 64-95 is reserved for RTCP. RTCP SR/RR/SDES/BYE/APP use PT 200-207.
    // IMPORTANT: bytes[1] >= 192 would also match valid HEVC/H264 RTP with Marker bit set
    // (e.g. PT=96 | M=1 → bytes[1]=0xE0=224), dropping the last packet of every video frame
    // and breaking IDR assembly. Use the precise RTCP range 200-207 instead.
    if ((pt >= 64 && pt <= 95) || (bytes[1] >= 200 && bytes[1] <= 207))
        return;

    // 3. Audio track validation: payload type must match expected audio codecs (0 = PCMU, 8 = PCMA, 10 = L16)
    if (!is_video && pt != 0 && pt != 8 && pt != 10) {
        return;
    }

    const uint16_t seq = static_cast<uint16_t>((bytes[2] << 8) | bytes[3]);
    std::vector<std::vector<uint8_t>> ready;

    bool discontinuity = false;
    {
        std::lock_guard<std::mutex> lock(reorder_mutex_);
        auto& state = is_video ? video_reorder_ : audio_reorder_;
        if (!state.initialized) {
            state.initialized = true;
            state.expected_seq = seq;
        }

        const int16_t distance = static_cast<int16_t>(seq - state.expected_seq);
        if (distance < -200 || distance > 2000) {
            // Sequence reset or long pause in stream — resync immediately
            state.expected_seq = seq;
            state.pending.clear();
        } else if (distance < 0) {
            return;
        }

        state.pending.try_emplace(seq, bytes, bytes + packet.size());
        discontinuity = flush_reordered_packets(is_video, ready);
    }

    if (is_video && discontinuity)
        rtsp_server_->notify_video_discontinuity();
    for (const auto& ordered : ready) {
        rtsp_server_->feed_raw_rtp(ordered.data(), ordered.size(), is_video);
    }
}

bool WebRTCPeer::flush_reordered_packets(bool is_video, std::vector<std::vector<uint8_t>>& ready) {
    bool discontinuity = false;
    auto& state = is_video ? video_reorder_ : audio_reorder_;
    while (true) {
        auto it = state.pending.find(state.expected_seq);
        if (it == state.pending.end())
            break;
        ready.push_back(std::move(it->second));
        state.pending.erase(it);
        state.expected_seq = static_cast<uint16_t>(state.expected_seq + 1);
    }

    // Absorb short out-of-order bursts from Tuya/SRTP without allowing a
    // genuinely lost packet to stall the stream forever.
    const size_t max_pending = is_video ? 8 : 6;
    if (state.pending.size() >= max_pending) {
        uint16_t nearest = state.pending.begin()->first;
        uint16_t nearest_distance = static_cast<uint16_t>(nearest - state.expected_seq);
        for (const auto& entry : state.pending) {
            const uint16_t candidate_distance = static_cast<uint16_t>(entry.first - state.expected_seq);
            if (candidate_distance < nearest_distance) {
                nearest = entry.first;
                nearest_distance = candidate_distance;
            }
        }
        discontinuity = nearest_distance > 0;
        state.expected_seq = nearest;
        while (true) {
            auto it = state.pending.find(state.expected_seq);
            if (it == state.pending.end())
                break;
            ready.push_back(std::move(it->second));
            state.pending.erase(it);
            state.expected_seq = static_cast<uint16_t>(state.expected_seq + 1);
        }
    }
    return discontinuity;
}

void WebRTCPeer::setup_peer_connection() {
    rtc::Configuration rtc_cfg;

    for (const auto& ice : config_.ice_servers) {
        rtc::IceServer srv(ice.url);
        if (!ice.username.empty()) {
            srv.username = ice.username;
            srv.password = ice.password;
        }
        rtc_cfg.iceServers.push_back(srv);
    }

    rtc_cfg.bindAddress = "0.0.0.0";
    rtc_cfg.disableAutoNegotiation = false;

    pc_ = std::make_shared<rtc::PeerConnection>(rtc_cfg);

    pc_->onStateChange([this](rtc::PeerConnection::State state) {
        if (state == rtc::PeerConnection::State::Connected) {
            std::cerr << "[WebRTCPeer] WebRTC Connected for " << config_.did << std::endl;
            connected_ = true;
            unhealthy_sent_ = false;
            last_video_packet_ms_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count();
            // Reset reorder state so stale expected_seq from a previous session
            // doesn't cause all incoming packets to be dropped (distance < 0 path).
            {
                std::lock_guard<std::mutex> rlock(reorder_mutex_);
                video_reorder_ = {};
                audio_reorder_ = {};
            }
            if (event_cb_) {
                event_cb_(to_json(EventWebRTCConnected{.did = config_.did}));
            }
        } else if (state == rtc::PeerConnection::State::Failed || state == rtc::PeerConnection::State::Closed || state == rtc::PeerConnection::State::Disconnected) {
            std::cerr << "[WebRTCPeer] WebRTC Disconnected for " << config_.did << " (state=" << static_cast<int>(state) << ")" << std::endl;
            connected_ = false;
            if (rtsp_server_) {
                rtsp_server_->clear_snapshot_annexb();
            }
            if (event_cb_) {
                event_cb_(to_json(EventWebRTCDisconnected{.did = config_.did}));
            }
        }
    });

    pc_->onLocalDescription([this](rtc::Description desc) {
        std::string sdp = std::string(desc);

        // Remove a=extmap lines for Tuya camera hardware compatibility
        std::regex extmap_re(R"(\r?\na=extmap[^\r\n]*)");
        sdp = std::regex_replace(sdp, extmap_re, "");

        if (event_cb_) {
            event_cb_(to_json(EventWebRTCOffer{
                .did = config_.did,
                .sdp = sdp,
            }));
        }
    });

    pc_->onLocalCandidate([this](rtc::Candidate cand) {
        std::string cand_str = cand.candidate();
        if (event_cb_) {
            event_cb_(to_json(EventICECandidate{
                .did = config_.did,
                .candidate = cand_str,
                .mid = cand.mid(),
            }));
        }
    });

    pc_->onTrack([this](std::shared_ptr<rtc::Track> track) {
        auto desc = track->description();
        std::cerr << "[WebRTCPeer] Received track: " << desc.type() << " mid=" << desc.mid() << std::endl;

        if (desc.type() == "video") {
            video_track_ = track;
            track->setMediaHandler(std::make_shared<rtc::RtcpReceivingSession>());
            track->onMessage([this](rtc::message_variant msg) {
                if (std::holds_alternative<rtc::binary>(msg)) {
                    const auto& bin = std::get<rtc::binary>(msg);
                    handle_video_packet(bin);
                }
            });
        } else if (desc.type() == "audio") {
            audio_recv_track_ = track;
            track->setMediaHandler(std::make_shared<rtc::RtcpReceivingSession>());
            track->onMessage([this](rtc::message_variant msg) {
                if (std::holds_alternative<rtc::binary>(msg)) {
                    const auto& bin = std::get<rtc::binary>(msg);
                    handle_audio_packet(bin);
                }
            });
        }
    });

    setup_tracks();
    pc_->setLocalDescription();
}

void WebRTCPeer::setup_tracks() {
    if (!pc_)
        return;

    // Add Audio Track (PCMU / 8000, SendRecv for Tuya backchannel support)
    const auto seed = std::hash<std::string>{}(config_.did);
    audio_send_ssrc_ = static_cast<uint32_t>((seed & 0x7fffffffU) | 0x20000000U);

    rtc::Description::Audio audio_desc("audio", rtc::Description::Direction::SendRecv);
    audio_desc.addPCMUCodec(0);
    audio_desc.addPCMACodec(8);
    audio_desc.addAudioCodec(10, "L16/8000/1");
    audio_desc.addSSRC(audio_send_ssrc_, "tuya-talkback-audio");
    audio_send_track_ = pc_->addTrack(audio_desc);
    audio_send_track_->setMediaHandler(std::make_shared<rtc::RtcpReceivingSession>());

    audio_send_track_->onOpen([this]() {
        std::cerr << "[WebRTCPeer] 🎙️ Camera WebRTC Audio Send track OPENED for " << config_.did << std::endl;
    });

    // Handle incoming camera audio packets on the bidirectional SendRecv track
    // if no separate remote audio track was negotiated via onTrack().
    audio_send_track_->onMessage([this](rtc::message_variant msg) {
        if (!audio_recv_track_ && std::holds_alternative<rtc::binary>(msg)) {
            const auto& bin = std::get<rtc::binary>(msg);
            handle_audio_packet(bin);
        }
    });

    // Add Video Track (H.264 / H.265, RecvOnly)
    rtc::Description::Video video_desc("video", rtc::Description::Direction::RecvOnly);
    video_desc.addH264Codec(96, "packetization-mode=1;profile-level-id=42001f");
    video_desc.addH264Codec(97, "packetization-mode=1;profile-level-id=42e01f");
    video_desc.addH265Codec(98);
    video_track_ = pc_->addTrack(video_desc);
    video_track_->setMediaHandler(std::make_shared<rtc::RtcpReceivingSession>());

    video_track_->onMessage([this](rtc::message_variant msg) {
        if (std::holds_alternative<rtc::binary>(msg)) {
            const auto& bin = std::get<rtc::binary>(msg);
            handle_video_packet(bin);
        }
    });
}

void WebRTCPeer::setup_data_channel() {
    if (!pc_)
        return;

    rtc::DataChannelInit dc_init;
    dc_init.reliability.maxRetransmits = 5;
    dc_init.reliability.unordered = false;

    data_channel_ = pc_->createDataChannel("fmp4Stream", dc_init);

    data_channel_->onOpen([this]() {
        std::cerr << "[WebRTCPeer] 🎉 DataChannel fmp4Stream OPENED for " << config_.did << std::endl;
        send_data_channel_msg("codec", "");
    });

    data_channel_->onClosed(
        [this]() { std::cerr << "[WebRTCPeer] DataChannel fmp4Stream CLOSED for " << config_.did << std::endl; });

    data_channel_->onError([this](const std::string& err) {
        std::cerr << "[WebRTCPeer] DataChannel ERROR for " << config_.did << ": " << err << std::endl;
    });

    data_channel_->onMessage([this](rtc::message_variant msg) {
        if (std::holds_alternative<std::string>(msg)) {
            const std::string& str = std::get<std::string>(msg);
            std::cerr << "[WebRTCPeer] 📩 DataChannel text msg: " << str << std::endl;
            if (str.find("\"codec\"") != std::string::npos) {
                send_data_channel_msg("start", "frame");
                send_data_channel_msg("start", "audio");
            } else if (str.find("\"recv\"") != std::string::npos) {
                send_data_channel_msg("complete", "");
            }
        } else if (std::holds_alternative<rtc::binary>(msg)) {
            const auto& bin = std::get<rtc::binary>(msg);
            if (bin.size() >= 12) {
                const auto* bytes = reinterpret_cast<const uint8_t*>(bin.data());
                const uint8_t pt = bytes[1] & 0x7f;
                if (pt == 0 || pt == 8 || pt == 10) {
                    handle_audio_packet(bin);
                } else {
                    handle_video_packet(bin);
                }
            } else {
                handle_video_packet(bin);
            }
        }
    });
}

void WebRTCPeer::send_data_channel_msg(const std::string& type, const std::string& msg) {
    if (!data_channel_ || !data_channel_->isOpen())
        return;
    std::string payload = "{\"type\":\"" + type + "\",\"msg\":\"" + msg + "\"}";
    std::cerr << "[WebRTCPeer] 📤 Sending DataChannel message: " << payload << std::endl;
    try {
        data_channel_->send(payload);
    } catch (const std::exception& e) {
        std::cerr << "[WebRTCPeer] Failed to send DataChannel msg: " << e.what() << std::endl;
    }
}

void WebRTCPeer::set_remote_description(const std::string& raw_sdp, const std::string& type) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!pc_)
        return;
    try {
        std::string sdp = raw_sdp;

        // Fix 1: Missing newline between c= and m=
        sdp = std::regex_replace(sdp, std::regex(R"(0\.0\.0\.0m=)"), "0.0.0.0\r\nm=");

        // Fix 2: Strip IPv6 candidates
        sdp = std::regex_replace(sdp, std::regex(R"(\r?\na=candidate:[^\r\n]*:[^\r\n]*)"), "");

        // Fix 3: Malformed a=rtpmap:6001 AES/KCP 3
        sdp = std::regex_replace(sdp, std::regex(R"(\r?\na=rtpmap:6001\s+AES/KCP[^\r\n]*)"), "");

        // Fix 4: Malformed custom attributes not in WebRTC standard
        sdp = std::regex_replace(sdp, std::regex(R"(\r?\na=aes-key:[^\r\n]*)"), "");

        // Fix 5: Camera SDP answers 'a=recvonly' for m=audio, which causes libdatachannel to configure
        // local track as SendOnly (dropping incoming mic audio RTP packets).
        // Change audio direction in answer to sendrecv so local track accepts incoming microphone RTP.
        size_t audio_pos = sdp.find("m=audio");
        if (audio_pos != std::string::npos) {
            size_t next_m = sdp.find("\r\nm=", audio_pos + 7);
            if (next_m == std::string::npos) {
                next_m = sdp.find("\nm=", audio_pos + 7);
            }
            size_t len = (next_m != std::string::npos) ? (next_m - audio_pos) : (sdp.length() - audio_pos);
            std::string audio_sec = sdp.substr(audio_pos, len);
            size_t recvonly_pos = audio_sec.find("a=recvonly");
            if (recvonly_pos != std::string::npos) {
                audio_sec.replace(recvonly_pos, 10, "a=sendrecv");
                sdp.replace(audio_pos, len, audio_sec);
                std::cerr << "[WebRTCPeer] Overrode camera audio SDP direction: a=recvonly -> a=sendrecv" << std::endl;
            }
        }

        rtc::Description desc(sdp, type);
        pc_->setRemoteDescription(desc);
        std::cerr << "[WebRTCPeer] Remote description successfully set (" << type << ")" << std::endl;

        // Also extract and add all candidates from the answer SDP if present
        std::istringstream stream(sdp);
        std::string line;
        std::string current_mid = "audio";
        while (std::getline(stream, line)) {
            if (line.rfind("a=mid:", 0) == 0) {
                current_mid = line.substr(6);
                while (!current_mid.empty() &&
                       (current_mid.back() == '\r' || current_mid.back() == '\n' || current_mid.back() == ' '))
                    current_mid.pop_back();
            } else if (line.rfind("a=candidate:", 0) == 0) {
                std::string cand_str = line.substr(2);
                while (!cand_str.empty() &&
                       (cand_str.back() == '\r' || cand_str.back() == '\n' || cand_str.back() == ' '))
                    cand_str.pop_back();
                try {
                    rtc::Candidate cand(cand_str, current_mid);
                    if (cand.family() != rtc::Candidate::Family::Ipv6) {
                        pc_->addRemoteCandidate(cand);
                        std::cerr << "[WebRTCPeer] Added embedded ICE candidate: " << cand_str << " mid=" << current_mid
                                  << std::endl;
                    }
                } catch (const std::exception& e) {
                    std::cerr << "[WebRTCPeer] Candidate error: " << e.what() << std::endl;
                }
            }
        }
    } catch (const std::exception& e) {
        std::cerr << "[WebRTCPeer] Error setting remote description: " << e.what() << std::endl;
    }
}

void WebRTCPeer::add_remote_candidate(const std::string& candidate, const std::string& mid) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!pc_)
        return;
    try {
        std::string cand_cleaned = candidate;
        if (cand_cleaned.rfind("a=", 0) == 0) {
            cand_cleaned = cand_cleaned.substr(2);
        }
        while (!cand_cleaned.empty() &&
               (cand_cleaned.back() == '\r' || cand_cleaned.back() == '\n' || cand_cleaned.back() == ' '))
            cand_cleaned.pop_back();

        if (cand_cleaned.empty())
            return;

        std::string target_mid = mid.empty() ? "audio" : mid;
        rtc::Candidate cand(cand_cleaned, target_mid);
        if (cand.family() != rtc::Candidate::Family::Ipv6) {
            pc_->addRemoteCandidate(cand);
            std::cerr << "[WebRTCPeer] Added remote ICE candidate: " << cand_cleaned << " mid=" << target_mid
                      << std::endl;
        }
    } catch (const std::exception& e) {
        std::cerr << "[WebRTCPeer] Error adding remote candidate: " << e.what() << std::endl;
    }
}

void WebRTCPeer::request_keyframe() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (video_track_ && video_track_->isOpen()) {
        try {
            video_track_->requestKeyframe();
            std::cerr << "[WebRTCPeer] 🔑 Sent RTCP PLI/FIR keyframe request" << std::endl;
        } catch (const std::exception& e) {
            std::cerr << "[WebRTCPeer] Keyframe request error: " << e.what() << std::endl;
        }
    }
    if (data_channel_ && data_channel_->isOpen()) {
        send_data_channel_msg("keyframe", "");
    }
}

void WebRTCPeer::set_quality(int channel) {
    send_data_channel_msg("quality", std::to_string(channel));
}

void WebRTCPeer::ptz(int action, int speed) {
    send_data_channel_msg("ptz", "{\"action\":" + std::to_string(action) + ",\"speed\":" + std::to_string(speed) + "}");
}

}  // namespace tuya
