#include "server.hpp"
#include "interleaved-writer.hpp"
#include <iostream>
#include <sstream>
#include <cstring>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <algorithm>
#include <array>

namespace tuya {

static inline int64_t steady_now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

RTSPServer::RTSPServer(int port, const std::string& path, KeyframeCallback kf_cb, bool is_hevc, bool audio_is_aac)
    : port_(port), path_(path), kf_req_cb_(std::move(kf_cb)), is_hevc_(is_hevc), audio_is_aac_(audio_is_aac) {}

RTSPServer::~RTSPServer() {
    stop();
}

void RTSPServer::set_snapshot_callback(std::function<void(const std::vector<uint8_t>&)> cb) {
    std::lock_guard<std::mutex> lock(snap_mutex_);
    snap_cb_ = std::move(cb);
}

void RTSPServer::set_media_ready_callback(std::function<void()> cb) {
    std::lock_guard<std::mutex> lock(snap_mutex_);
    media_ready_cb_ = std::move(cb);
}

void RTSPServer::set_ingest_stats_callback(std::function<void(bool, const RtpIngressStats&)> cb) {
    ingest_stats_cb_ = std::move(cb);
}

void RTSPServer::notify_media_ready(bool video, bool audio) {
    if (video)
        media_video_ready_.store(true, std::memory_order_release);
    if (audio)
        media_audio_ready_.store(true, std::memory_order_release);
    if (!media_video_ready_.load(std::memory_order_acquire) ||
        !media_audio_ready_.load(std::memory_order_acquire))
        return;
    bool expected = false;
    if (!media_ready_sent_.compare_exchange_strong(expected, true, std::memory_order_acq_rel))
        return;
    std::function<void()> callback;
    {
        std::lock_guard<std::mutex> lock(snap_mutex_);
        callback = media_ready_cb_;
    }
    if (callback)
        callback();
}

std::vector<uint8_t> RTSPServer::get_latest_annexb() const {
    std::lock_guard<std::mutex> lock(snap_mutex_);
    return snapshot_annexb_;
}

void RTSPServer::clear_snapshot_annexb() {
    std::lock_guard<std::mutex> lock(snap_mutex_);
    snapshot_annexb_.clear();
}

static void append_annexb_unit(std::vector<uint8_t>& out, const uint8_t* unit, size_t len) {
    static const uint8_t start_code[4] = {0x00, 0x00, 0x00, 0x01};
    out.insert(out.end(), start_code, start_code + 4);
    out.insert(out.end(), unit, unit + len);
}

void RTSPServer::rebuild_snapshot_annexb() {
    // Concatenate VPS+SPS+PPS (single-NAL RTP payloads) + reassembled IDR (RFC 7798 FU).
    std::vector<uint8_t> annexb;
    annexb.reserve(256 * 1024);

    auto append_single_nal = [&](const std::vector<uint8_t>& pkt) {
        // pkt = [12B RTP header][2B NAL header + payload]
        if (pkt.size() < 14)
            return;
        append_annexb_unit(annexb, pkt.data() + 12, pkt.size() - 12);
    };

    {
        std::lock_guard<std::mutex> lock(param_mutex_);
        append_single_nal(vps_pkt_);
        append_single_nal(sps_pkt_);
        append_single_nal(pps_pkt_);
    }

    bool nal_open = false;  // an FU reassembly is in progress
    {
        std::lock_guard<std::mutex> lock(idr_cache_mutex_);
        for (const auto& pkt : idr_cache_pkts_) {
            if (pkt.size() < 14)
                continue;
            uint8_t h0 = pkt[12];
            uint8_t nal_type = (h0 >> 1) & 0x3F;

            if (nal_type == 32 || nal_type == 33 || nal_type == 34) {
                if (nal_open) {
                    nal_open = false;
                }
                append_single_nal(pkt);
                continue;
            }

            if ((h0 & 0xFE) == 0x62) {
                // Fragmentation Unit
                if (pkt.size() < 15)
                    continue;
                uint8_t fu = pkt[14];
                bool start = (fu & 0x80) != 0;
                bool end = (fu & 0x40) != 0;
                uint8_t real_nal = fu & 0x3F;

                if (start) {
                    // Write Annex-B start code + reconstruct 2-byte HEVC NAL header
                    uint16_t nal_header =
                        static_cast<uint16_t>((real_nal << 9) | (0 << 3) | 1);  // nuh_layer_id=0, tid=1
                    static const uint8_t sc[4] = {0x00, 0x00, 0x00, 0x01};
                    annexb.insert(annexb.end(), sc, sc + 4);
                    annexb.push_back(static_cast<uint8_t>(nal_header >> 8));
                    annexb.push_back(static_cast<uint8_t>(nal_header & 0xFF));
                    nal_open = true;
                }
                if (pkt.size() > 15) {
                    annexb.insert(annexb.end(), pkt.begin() + 15, pkt.end());
                }
                if (end) {
                    nal_open = false;
                }
            } else {
                // Single NAL (unfragmented) — treat as Annex-B unit directly
                if (nal_open)
                    nal_open = false;
                const uint8_t* unit = pkt.data() + 12;
                size_t unit_len = pkt.size() - 12;
                // Unit may be [2B NAL header + payload]
                append_annexb_unit(annexb, unit, unit_len);
            }
        }
    }

    {
        std::lock_guard<std::mutex> lock(snap_mutex_);
        if (!annexb.empty())
            snapshot_annexb_.swap(annexb);
        if (snap_cb_ && !snapshot_annexb_.empty())
            snap_cb_(snapshot_annexb_);
    }
}

bool RTSPServer::start() {
    server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd_ < 0)
        return false;

    int opt = 1;
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    // Camera RTSP is an internal NVR pipeline only; never expose the relay on the LAN.
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port_);

    if (bind(server_fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(server_fd_);
        server_fd_ = -1;
        return false;
    }

    if (listen(server_fd_, 16) < 0) {
        close(server_fd_);
        server_fd_ = -1;
        return false;
    }

    running_ = true;
    accept_thread_ = std::thread(&RTSPServer::accept_loop, this);
    silence_thread_ = std::thread(&RTSPServer::silence_loop, this);
    return true;
}

static int bind_udp_ingest_socket(int port) {
    const int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0)
        return -1;

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    timeval receive_timeout{};
    receive_timeout.tv_usec = 250000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &receive_timeout, sizeof(receive_timeout));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);
    if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

bool RTSPServer::start_udp_ingest(int video_port, int audio_port) {
    if (!running_ || (udp_fd_ >= 0 && audio_udp_fd_ >= 0))
        return false;

    if (video_port > 0 && udp_fd_ < 0) {
        udp_fd_ = bind_udp_ingest_socket(video_port);
        if (udp_fd_ < 0)
            return false;
        udp_thread_ = std::thread(&RTSPServer::udp_ingest_loop, this, udp_fd_, true);
    }

    if (audio_port > 0 && audio_udp_fd_ < 0) {
        audio_udp_fd_ = bind_udp_ingest_socket(audio_port);
        if (audio_udp_fd_ < 0) {
            return false;
        }
        audio_udp_thread_ = std::thread(&RTSPServer::udp_ingest_loop, this, audio_udp_fd_, false);
    }
    return true;
}

void RTSPServer::udp_ingest_loop(int socket_fd, bool is_video) {
    std::array<uint8_t, 2048> packet{};
    RtpIngress ingress(socket_fd, is_video);
    while (running_) {
        const ssize_t len = ingress.receive(socket_fd, packet.data(), packet.size());
        if (len <= 0) {
            if (running_)
                usleep(1000);
            continue;
        }
        if (is_video && ingress.gap)
            notify_video_discontinuity();
        feed_raw_rtp(packet.data(), static_cast<size_t>(len), is_video);
        if (ingest_stats_cb_ && ingress.report_due())
            ingest_stats_cb_(is_video, ingress.stats);
    }
    if (ingest_stats_cb_ && ingress.stats.packets)
        ingest_stats_cb_(is_video, ingress.stats);
}

void RTSPServer::notify_video_discontinuity() {
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto& entry : clients_) {
            entry.second.wait_idr = true;
            entry.second.wait_idr_started = false;
        }
    }
    {
        std::lock_guard<std::mutex> lock(idr_cache_mutex_);
        current_idr_pkts_.clear();
        idr_cache_pkts_.clear();
        collecting_idr_ = false;
    }
    {
        std::lock_guard<std::mutex> lock(param_mutex_);
        sps_pkt_.clear();
        pps_pkt_.clear();
    }
    media_video_ready_.store(false, std::memory_order_release);
    media_audio_ready_.store(false, std::memory_order_release);
    media_ready_sent_.store(false, std::memory_order_release);
    if (kf_req_cb_)
        kf_req_cb_();
}

void RTSPServer::stop() {
    running_ = false;
    if (server_fd_ >= 0) {
        shutdown(server_fd_, SHUT_RDWR);
        close(server_fd_);
        server_fd_ = -1;
    }
    if (udp_fd_ >= 0) {
        shutdown(udp_fd_, SHUT_RDWR);
        close(udp_fd_);
        udp_fd_ = -1;
    }
    if (audio_udp_fd_ >= 0) {
        shutdown(audio_udp_fd_, SHUT_RDWR);
        close(audio_udp_fd_);
        audio_udp_fd_ = -1;
    }
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto& [fd, session] : clients_)
            shutdown(fd, SHUT_RDWR);
    }
    if (accept_thread_.joinable())
        accept_thread_.join();
    if (udp_thread_.joinable())
        udp_thread_.join();
    if (audio_udp_thread_.joinable())
        audio_udp_thread_.join();
    if (silence_thread_.joinable())
        silence_thread_.join();
    {
        std::lock_guard<std::mutex> lock(client_threads_mutex_);
        for (auto& thread : client_threads_) {
            if (thread.joinable())
                thread.join();
        }
        client_threads_.clear();
    }
    std::lock_guard<std::mutex> lock(clients_mutex_);
    clients_.clear();
}

void RTSPServer::accept_loop() {
    while (running_) {
        sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(server_fd_, (struct sockaddr*)&client_addr, &client_len);
        if (client_fd < 0) {
            if (!running_)
                break;
            usleep(10000);
            continue;
        }

        int opt = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt));
        int sndbuf = 256 * 1024;
        setsockopt(client_fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
        // MSG_DONTWAIT is used for media writes. Also bound a single write on
        // platforms that can still wait for socket space despite that flag.
        timeval send_timeout{};
        send_timeout.tv_usec = 10000;
        setsockopt(client_fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));

        std::lock_guard<std::mutex> lock(client_threads_mutex_);
        client_threads_.emplace_back([this, client_fd]() { client_loop(client_fd); });
    }
}

void RTSPServer::client_loop(int client_fd) {
    RTSPClientSession session;
    session.socket_fd = client_fd;
    session.session_id = std::to_string(reinterpret_cast<uintptr_t>(this) ^ static_cast<uintptr_t>(client_fd));

    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        clients_[client_fd] = session;
    }

    char buffer[4096];
    std::string request_acc;

    while (running_) {
        ssize_t n = recv(client_fd, buffer, sizeof(buffer) - 1, 0);
        if (n <= 0)
            break;

        buffer[n] = '\0';
        request_acc.append(buffer, n);

        size_t pos;
        while ((pos = request_acc.find("\r\n\r\n")) != std::string::npos) {
            std::string req = request_acc.substr(0, pos + 4);
            request_acc.erase(0, pos + 4);
            handle_rtsp_request(client_fd, req, session);
        }
    }

    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        clients_.erase(client_fd);
    }
    close(client_fd);
}

static std::string base64_encode(const uint8_t* data, size_t len) {
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string ret;
    int val = 0, valb = -6;
    for (size_t i = 0; i < len; ++i) {
        val = (val << 8) + data[i];
        valb += 8;
        while (valb >= 0) {
            ret.push_back(tbl[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6)
        ret.push_back(tbl[((val << 8) >> (valb + 8)) & 0x3F]);
    while (ret.size() % 4)
        ret.push_back('=');
    return ret;
}

void RTSPServer::handle_rtsp_request(int client_fd, const std::string& req, RTSPClientSession& session) {
    std::istringstream stream(req);
    std::string method, url, version;
    stream >> method >> url >> version;

    std::string cseq = "1";
    std::string line;
    while (std::getline(stream, line)) {
        if (line.find("CSeq:") != std::string::npos || line.find("Cseq:") != std::string::npos) {
            size_t colon = line.find(':');
            if (colon != std::string::npos) {
                cseq = line.substr(colon + 1);
                cseq.erase(0, cseq.find_first_not_of(" \t\r\n"));
                cseq.erase(cseq.find_last_not_of(" \t\r\n") + 1);
            }
        }
    }

    std::ostringstream resp;

    if (method == "OPTIONS") {
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN\r\n\r\n";
    } else if (method == "DESCRIBE") {
        std::string content_base = url.empty() ? ("rtsp://0.0.0.0:" + std::to_string(port_) + "/" + path_ + "/")
                                               : (url.back() == '/' ? url : (url + "/"));
        std::ostringstream sdp;
        sdp << "v=0\r\n"
            << "o=- " << session.session_id << " 1 IN IP4 127.0.0.1\r\n"
            << "s=Tuya Native Stream\r\n"
            << "t=0 0\r\n"
            << "a=control:*\r\n"
            << "a=range:npt=0-\r\n"
            << "m=video 0 RTP/AVP 96\r\n";
        if (is_hevc_) {
            sdp << "a=rtpmap:96 H265/90000\r\n";
            std::lock_guard<std::mutex> param_lock(param_mutex_);
            if (!vps_pkt_.empty() && !sps_pkt_.empty() && !pps_pkt_.empty()) {
                std::string b64_vps = base64_encode(vps_pkt_.data() + 12, vps_pkt_.size() - 12);
                std::string b64_sps = base64_encode(sps_pkt_.data() + 12, sps_pkt_.size() - 12);
                std::string b64_pps = base64_encode(pps_pkt_.data() + 12, pps_pkt_.size() - 12);
                sdp << "a=fmtp:96 sprop-vps=" << b64_vps << ";sprop-sps=" << b64_sps << ";sprop-pps=" << b64_pps
                    << "\r\n";
            }
        } else {
            sdp << "a=rtpmap:96 H264/90000\r\n";
            std::lock_guard<std::mutex> param_lock(param_mutex_);
            std::string profile_level = "420028";
            if (sps_pkt_.size() >= 16) {
                char pl_buf[7];
                snprintf(pl_buf, sizeof(pl_buf), "%02x%02x%02x", sps_pkt_[13], sps_pkt_[14], sps_pkt_[15]);
                profile_level = pl_buf;
            }
            sdp << "a=fmtp:96 packetization-mode=1;profile-level-id=" << profile_level;
            if (!sps_pkt_.empty() && !pps_pkt_.empty()) {
                std::string b64_sps = base64_encode(sps_pkt_.data() + 12, sps_pkt_.size() - 12);
                std::string b64_pps = base64_encode(pps_pkt_.data() + 12, pps_pkt_.size() - 12);
                sdp << ";sprop-parameter-sets=" << b64_sps << "," << b64_pps;
            }
            sdp << "\r\n";
        }
        sdp << "a=control:track0\r\n";
        if (audio_is_aac_) {
            sdp << "m=audio 0 RTP/AVP 97\r\n"
                << "a=rtpmap:97 MPEG4-GENERIC/16000/1\r\n"
                << "a=fmtp:97 "
                   "profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config="
                   "140856E500\r\n"
                << "a=control:track1\r\n";
        } else {
            sdp << "m=audio 0 RTP/AVP 0\r\n"
                << "a=rtpmap:0 PCMU/8000\r\n"
                << "a=control:track1\r\n";
        }

        std::string sdp_str = sdp.str();
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Content-Type: application/sdp\r\n"
             << "Content-Base: " << content_base << "\r\n"
             << "Content-Length: " << sdp_str.length() << "\r\n\r\n"
             << sdp_str;
    } else if (method == "SETUP") {
        std::string transport = "";
        bool is_tcp = false;
        size_t tr_pos = req.find("Transport:");
        if (tr_pos == std::string::npos)
            tr_pos = req.find("transport:");
        if (tr_pos != std::string::npos) {
            size_t eol = req.find("\r\n", tr_pos);
            std::string tr_line = req.substr(tr_pos, eol - tr_pos);
            size_t il_pos = tr_line.find("interleaved=");
            if (il_pos != std::string::npos || tr_line.find("RTP/AVP/TCP") != std::string::npos) {
                is_tcp = true;
                bool is_audio = (url.find("track1") != std::string::npos || url.find("audio") != std::string::npos);
                int rtp_ch = is_audio ? 2 : 0;
                int rtcp_ch = rtp_ch + 1;
                if (il_pos != std::string::npos) {
                    sscanf(tr_line.c_str() + il_pos, "interleaved=%d-%d", &rtp_ch, &rtcp_ch);
                }
                if (is_audio) {
                    session.audio_rtp_channel = static_cast<uint8_t>(rtp_ch);
                    session.audio_rtcp_channel = static_cast<uint8_t>(rtcp_ch);
                } else {
                    session.video_rtp_channel = static_cast<uint8_t>(rtp_ch);
                    session.video_rtcp_channel = static_cast<uint8_t>(rtcp_ch);
                }
                transport = "RTP/AVP/TCP;unicast;interleaved=" + std::to_string(rtp_ch) + "-" + std::to_string(rtcp_ch);
            }
        }

        if (!is_tcp) {
            // Immediately reject UDP with 461 so VLC / Live555 falls back to TCP interleaved instantaneously (<10ms)
            resp << "RTSP/1.0 461 Unsupported Transport\r\n"
                 << "CSeq: " << cseq << "\r\n\r\n";
            std::string resp_str = resp.str();
            send(client_fd, resp_str.data(), resp_str.length(), 0);
            return;
        }

        {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            clients_[client_fd] = session;
        }
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Session: " << session.session_id << ";timeout=60\r\n"
             << "Transport: " << transport << "\r\n\r\n";
    } else if (method == "PLAY") {
        session.is_playing = true;
        session.wait_idr = true;  // Wait for clean keyframe start so zero image artifacts
        session.out_video_seq = 0;
        session.out_audio_seq = 0;
        session.play_started = true;
        session.play_start_time = std::chrono::steady_clock::now();
        session.has_last_in_video_ts = false;
        session.current_frame_video_ts = session.out_base_video_ts;
        session.last_audio_out_ts = session.out_base_audio_ts;
        std::string content_base = url.empty() ? ("rtsp://0.0.0.0:" + std::to_string(port_) + "/" + path_ + "/")
                                               : (url.back() == '/' ? url : (url + "/"));

        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Session: " << session.session_id << "\r\n"
             << "Range: npt=0.000-\r\n"
             << "RTP-Info: url=" << content_base << "track0;seq=0;rtptime=" << session.out_base_video_ts
             << ",url=" << content_base << "track1;seq=0;rtptime=" << session.out_base_audio_ts << "\r\n\r\n";

        // Prime late RTSP clients from the last complete parameter-set + IDR cache.
        // This avoids waiting for the camera's next GOP before VLC/Scrypted can decode.
        std::vector<std::vector<uint8_t>> cached_idr;
        {
            std::lock_guard<std::mutex> cache_lock(idr_cache_mutex_);
            cached_idr = idr_cache_pkts_;
        }
        {
            // Response, initial still and live activation form one cutover.
            // Ingest must not write RTP before the PLAY response or insert a
            // newer frame between the cached still and the fresh-IDR gate.
            std::lock_guard<std::mutex> clients_lock(clients_mutex_);
            const std::string resp_str = resp.str();
            if (send(client_fd, resp_str.data(), resp_str.length(), MSG_NOSIGNAL) !=
                static_cast<ssize_t>(resp_str.length())) {
                shutdown(client_fd, SHUT_RDWR);
                return;
            }
            auto& active = clients_[client_fd];
            active = session;
            if (!cached_idr.empty()) {
                for (const auto& packet : cached_idr) {
                    send_client_rtp_packet(client_fd, active, true, packet.data(), packet.size());
                }
                // This cached still is immediately decodable, but the next
                // live P-frame may depend on pictures before PLAY. Resume only
                // at a new IDR rather than attach the decoder in mid-GOP.
                active.wait_idr = true;
                active.wait_idr_started = false;
            }
        }

        // Also ask for a fresh keyframe so the cached GOP is replaced immediately.
        if (kf_req_cb_)
            kf_req_cb_();
        return;
    } else if (method == "TEARDOWN") {
        session.is_playing = false;
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n\r\n";
    }

    std::string resp_str = resp.str();
    send(client_fd, resp_str.data(), resp_str.length(), 0);
}

void RTSPServer::send_interleaved_packet(int fd, uint8_t channel, const uint8_t* rtp_data, size_t len) {
    if (!write_interleaved_packet(fd, channel, rtp_data, len)) {
        // Once a packet is only partly written, continuing would corrupt the
        // TCP framing. Wake the client reader and let it reconnect cleanly.
        shutdown(fd, SHUT_RDWR);
    }
}

void RTSPServer::send_client_rtp_packet(int fd, RTSPClientSession& session, bool is_video, const uint8_t* data,
                                        size_t len) {
    if (fd < 0 || !data || len < 12)
        return;

    uint8_t channel = is_video ? session.video_rtp_channel : session.audio_rtp_channel;

    uint32_t in_ts = (static_cast<uint32_t>(data[4]) << 24) | (static_cast<uint32_t>(data[5]) << 16) |
                     (static_cast<uint32_t>(data[6]) << 8) | static_cast<uint32_t>(data[7]);

    const auto now = std::chrono::steady_clock::now();
    if (!session.play_started) {
        session.play_started = true;
        session.play_start_time = now;
    }

    int64_t elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - session.play_start_time).count();
    if (elapsed_ms < 0)
        elapsed_ms = 0;

    uint16_t out_seq = 0;
    uint32_t out_ts = 0;

    if (is_video) {
        out_seq = session.out_video_seq++;

        // All RTP packets belonging to the same video frame share the exact same timestamp (RFC 6184)
        if (!session.has_last_in_video_ts) {
            session.has_last_in_video_ts = true;
            session.last_in_video_ts = in_ts;
            session.current_frame_video_ts = session.out_base_video_ts + static_cast<uint32_t>(elapsed_ms * 90);
        } else if (in_ts != session.last_in_video_ts) {
            const int32_t delta = static_cast<int32_t>(in_ts - session.last_in_video_ts);
            // Preserve the media clock even when TCP/UDP delivers several
            // frames in one scheduler slice. Arrival time collapses a burst to
            // +1 ticks, which causes non-monotonic DTS and playback stalls.
            if (delta > -30 * 90000 && delta < 30 * 90000) {
                session.current_frame_video_ts += delta;
            } else {
                // A restarted publisher may choose a new random RTP origin.
                uint32_t calc_ts = session.out_base_video_ts + static_cast<uint32_t>(elapsed_ms * 90);
                if (static_cast<int32_t>(calc_ts - session.current_frame_video_ts) <= 0)
                    calc_ts = session.current_frame_video_ts + 1;
                session.current_frame_video_ts = calc_ts;
            }
            session.last_in_video_ts = in_ts;
        }
        out_ts = session.current_frame_video_ts;
    } else {
        out_seq = session.out_audio_seq++;

        if (audio_is_aac_) {
            if (!session.has_audio_base_ts) {
                session.has_audio_base_ts = true;
                session.last_audio_out_ts = session.out_base_audio_ts + static_cast<uint32_t>(elapsed_ms * 16);
            } else {
                const uint32_t delta = in_ts - session.last_in_audio_ts;
                if (delta < 30 * 16000) {
                    session.last_audio_out_ts += delta;
                } else {
                    uint32_t calc_ts = session.out_base_audio_ts + static_cast<uint32_t>(elapsed_ms * 16);
                    if (static_cast<int32_t>(calc_ts - session.last_audio_out_ts) <= 0)
                        calc_ts = session.last_audio_out_ts + 1;
                    session.last_audio_out_ts = calc_ts;
                }
            }
            session.last_in_audio_ts = in_ts;
            out_ts = session.last_audio_out_ts;
        } else {
            // Anchor outbound PCMU timestamps to incoming camera RTP timestamp to guarantee
            // exact jitter-free pacing and avoid synthetic discontinuities / clicks.
            if (!session.has_audio_base_ts) {
                session.has_audio_base_ts = true;
                session.in_audio_base_ts = in_ts;
                session.last_in_audio_ts = in_ts;
                out_ts = session.out_base_audio_ts;
                session.last_audio_out_ts = out_ts;
            } else {
                int32_t diff = static_cast<int32_t>(in_ts - session.last_in_audio_ts);
                if (diff > 0 && diff < 8000) {
                    session.last_audio_out_ts += static_cast<uint32_t>(diff);
                } else {
                    const size_t num_samples = (len > 12) ? (len - 12) : 160;
                    session.last_audio_out_ts += static_cast<uint32_t>(num_samples);
                }
                session.last_in_audio_ts = in_ts;
                out_ts = session.last_audio_out_ts;
            }
        }
    }

    uint8_t buf[2048];
    std::vector<uint8_t> dynamic_buf;
    uint8_t* target = buf;
    if (len > sizeof(buf)) {
        dynamic_buf.resize(len);
        target = dynamic_buf.data();
    }
    std::memcpy(target, data, len);

    // If audio, ensure payload type is correct
    if (!is_video) {
        const uint8_t expected_pt = audio_is_aac_ ? 97 : 0;
        target[1] = (data[1] & 0x80) | expected_pt;
    }

    target[2] = (out_seq >> 8) & 0xFF;
    target[3] = out_seq & 0xFF;
    target[4] = (out_ts >> 24) & 0xFF;
    target[5] = (out_ts >> 16) & 0xFF;
    target[6] = (out_ts >> 8) & 0xFF;
    target[7] = out_ts & 0xFF;

    send_interleaved_packet(fd, channel, target, len);
}

void RTSPServer::feed_frame(const MediaFrame& frame) {
    if (frame.is_video) {
        if (frame.is_keyframe) {
            std::lock_guard<std::mutex> lock(gop_mutex_);
            gop_cache_.clear();
            has_keyframe_ = true;
        }

        if (has_keyframe_) {
            std::lock_guard<std::mutex> lock(gop_mutex_);
            gop_cache_.push_back(frame);
            if (gop_cache_.size() > 120)
                gop_cache_.erase(gop_cache_.begin());
        }

        packetize_and_send_video(frame.data.data(), frame.data.size(), frame.timestamp_ms * 90, frame.is_keyframe);
    } else {
        last_audio_feed_ms_.store(steady_now_ms(), std::memory_order_relaxed);
        notify_media_ready(false, true);
        packetize_and_send_audio(frame.data.data(), frame.data.size(), frame.timestamp_ms * 16);
    }
}

void RTSPServer::packetize_and_send_video(const uint8_t* nalu, size_t len, uint32_t ts_90k, bool /*is_key*/) {
    if (len == 0)
        return;

    std::lock_guard<std::mutex> lock(clients_mutex_);
    for (auto& [fd, session] : clients_) {
        if (!session.is_playing)
            continue;

        // Standard RTP Header (12 bytes)
        uint8_t rtp_header[12];
        rtp_header[0] = 0x80;
        rtp_header[1] = 96;  // Dynamic H.265 Payload Type
        rtp_header[2] = (session.video_seq >> 8) & 0xFF;
        rtp_header[3] = session.video_seq & 0xFF;
        session.video_seq++;

        rtp_header[4] = (ts_90k >> 24) & 0xFF;
        rtp_header[5] = (ts_90k >> 16) & 0xFF;
        rtp_header[6] = (ts_90k >> 8) & 0xFF;
        rtp_header[7] = ts_90k & 0xFF;

        rtp_header[8] = 0x12;
        rtp_header[9] = 0x34;
        rtp_header[10] = 0x56;
        rtp_header[11] = 0x78;  // SSRC

        // If fits in single MTU (<= 1400)
        if (len <= 1400) {
            rtp_header[1] |= 0x80;  // Marker bit
            std::vector<uint8_t> rtp_packet(12 + len);
            std::memcpy(rtp_packet.data(), rtp_header, 12);
            std::memcpy(rtp_packet.data() + 12, nalu, len);
            send_interleaved_packet(fd, session.video_rtp_channel, rtp_packet.data(), rtp_packet.size());
        } else {
            // Fragmentation Unit (FU)
            uint8_t nal_type = (nalu[0] & 0x7E) >> 1;
            size_t offset = 2;  // HEVC 2-byte header
            size_t remaining = len - offset;
            bool first = true;

            while (remaining > 0) {
                size_t chunk = std::min<size_t>(remaining, 1400);
                bool last = (chunk == remaining);

                rtp_header[2] = (session.video_seq >> 8) & 0xFF;
                rtp_header[3] = session.video_seq & 0xFF;
                session.video_seq++;

                if (last)
                    rtp_header[1] |= 0x80;
                else
                    rtp_header[1] &= 0x7F;

                uint8_t fu_header[3];
                fu_header[0] = (49 << 1);  // HEVC FU type 49
                fu_header[1] = 1;
                fu_header[2] = (first ? 0x80 : 0x00) | (last ? 0x40 : 0x00) | (nal_type & 0x3F);

                std::vector<uint8_t> rtp_packet(12 + 3 + chunk);
                std::memcpy(rtp_packet.data(), rtp_header, 12);
                std::memcpy(rtp_packet.data() + 12, fu_header, 3);
                std::memcpy(rtp_packet.data() + 15, nalu + offset, chunk);

                send_interleaved_packet(fd, session.video_rtp_channel, rtp_packet.data(), rtp_packet.size());

                offset += chunk;
                remaining -= chunk;
                first = false;
            }
        }
    }
}

void RTSPServer::packetize_and_send_audio(const uint8_t* data, size_t len, uint32_t ts_samples) {
    if (len == 0)
        return;

    std::lock_guard<std::mutex> lock(clients_mutex_);
    for (auto& [fd, session] : clients_) {
        if (!session.is_playing)
            continue;

        uint8_t rtp_header[12 + 4];
        rtp_header[0] = 0x80;
        rtp_header[1] = 97 | 0x80;  // AAC Payload Type with Marker
        rtp_header[2] = (session.audio_seq >> 8) & 0xFF;
        rtp_header[3] = session.audio_seq & 0xFF;
        session.audio_seq++;

        rtp_header[4] = (ts_samples >> 24) & 0xFF;
        rtp_header[5] = (ts_samples >> 16) & 0xFF;
        rtp_header[6] = (ts_samples >> 8) & 0xFF;
        rtp_header[7] = ts_samples & 0xFF;

        rtp_header[8] = 0x98;
        rtp_header[9] = 0x76;
        rtp_header[10] = 0x54;
        rtp_header[11] = 0x32;  // Audio SSRC

        // AU Header for AAC-hbr
        rtp_header[12] = 0x00;
        rtp_header[13] = 0x10;  // AU-headers-length (16 bits = 2 bytes)
        rtp_header[14] = (len >> 5) & 0xFF;
        rtp_header[15] = ((len & 0x1F) << 3);

        std::vector<uint8_t> rtp_packet(16 + len);
        std::memcpy(rtp_packet.data(), rtp_header, 16);
        std::memcpy(rtp_packet.data() + 16, data, len);

        send_interleaved_packet(fd, session.audio_rtp_channel, rtp_packet.data(), rtp_packet.size());
    }
}

static inline uint8_t linear_to_mulaw(int16_t pcm_val) {
    int16_t mask;
    int16_t seg;
    uint8_t uval;

    if (pcm_val == -32768)
        pcm_val = -32767;
    if (pcm_val < 0) {
        pcm_val = -pcm_val;
        mask = 0x7F;
    } else {
        mask = 0xFF;
    }

    if (pcm_val > 32635)
        pcm_val = 32635;
    pcm_val += 0x84;

    if (pcm_val >= (0x4000))
        seg = 7;
    else if (pcm_val >= (0x2000))
        seg = 6;
    else if (pcm_val >= (0x1000))
        seg = 5;
    else if (pcm_val >= (0x0800))
        seg = 4;
    else if (pcm_val >= (0x0400))
        seg = 3;
    else if (pcm_val >= (0x0200))
        seg = 2;
    else if (pcm_val >= (0x0100))
        seg = 1;
    else
        seg = 0;

    uval = static_cast<uint8_t>((seg << 4) | ((pcm_val >> (seg + 3)) & 0x0F));
    return (uval ^ mask);
}

void RTSPServer::feed_raw_rtp(const uint8_t* data, size_t len, bool is_video) {
    if (!data || len <= 12)
        return;

    if (!is_video) {
        if (!audio_is_aac_ && len > 12) {
            // Robustly determine true audio payload offset (handling CC CSRCs and extension headers)
            const uint8_t cc = data[0] & 0x0F;
            const bool has_ext = (data[0] & 0x10) != 0;
            size_t header_len = 12 + cc * 4;
            if (has_ext && len >= header_len + 4) {
                const uint16_t ext_len = (static_cast<uint16_t>(data[header_len + 2]) << 8) | data[header_len + 3];
                header_len += 4 + ext_len * 4;
            }

            if (len > header_len) {
                // Tuya WebRTC transmits raw 16-bit signed Linear PCM (codecType 101 / 0x81) in PT=0 packets.
                // When serving standard PCMU/8000 in SDP, convert linear PCM to standard G.711 mu-law
                // so standard RTSP decoders (FFmpeg, VLC, Scrypted) decode pristine audio without clipping.
                const size_t payload_len = len - header_len;
                const size_t num_samples = payload_len / 2;
                std::vector<uint8_t> pcmu_rtp(12 + num_samples);
                std::memcpy(pcmu_rtp.data(), data, 12);
                pcmu_rtp[0] = 0x80;  // Standard RTP v2 header without extensions/CSRC in outbound RTSP
                pcmu_rtp[1] = (data[1] & 0x80) | 0x00;  // PT=0 (PCMU)

                const uint8_t* pcm_bytes = data + header_len;
                for (size_t i = 0; i < num_samples; ++i) {
                    int16_t sample = static_cast<int16_t>(pcm_bytes[i * 2] | (pcm_bytes[i * 2 + 1] << 8));
                    pcmu_rtp[12 + i] = linear_to_mulaw(sample);
                }

                last_audio_feed_ms_.store(steady_now_ms(), std::memory_order_relaxed);
                std::lock_guard<std::mutex> lock(clients_mutex_);
                for (auto& [fd, session] : clients_) {
                    if (!session.is_playing)
                        continue;
                    send_client_rtp_packet(fd, session, false, pcmu_rtp.data(), pcmu_rtp.size());
                }
            }
            return;
        }

        last_audio_feed_ms_.store(steady_now_ms(), std::memory_order_relaxed);
        notify_media_ready(false, true);
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto& [fd, session] : clients_) {
            if (!session.is_playing)
                continue;
            send_client_rtp_packet(fd, session, false, data, len);
        }
        return;
    }

    // Video packet processing
    if (!is_hevc_) {
        const uint8_t nal_type = data[12] & 0x1F;
        const bool is_fu = nal_type == 28 && len >= 14;
        const uint8_t fu_type = is_fu ? (data[13] & 0x1F) : 0;
        const bool fu_start = is_fu && (data[13] & 0x80);
        bool is_sps = nal_type == 7;
        bool is_pps = nal_type == 8;
        bool stap_has_idr = false;
        std::vector<uint8_t> parameter_sps, parameter_pps;
        auto parameter_packet = [&](const uint8_t* nalu, size_t size) {
            std::vector<uint8_t> packet(data, data + 12);
            packet[1] &= 0x7f;
            packet.insert(packet.end(), nalu, nalu + size);
            return packet;
        };
        if (is_sps)
            parameter_sps = parameter_packet(data + 12, len - 12);
        if (is_pps)
            parameter_pps = parameter_packet(data + 12, len - 12);
        if (nal_type == 24) {
            size_t offset = 13;
            while (offset + 2 <= len) {
                const size_t nalu_len = (static_cast<size_t>(data[offset]) << 8) | data[offset + 1];
                offset += 2;
                if (nalu_len == 0 || offset + nalu_len > len)
                    break;
                const uint8_t stap_type = data[offset] & 0x1F;
                if (stap_type == 7)
                    parameter_sps = parameter_packet(data + offset, nalu_len);
                if (stap_type == 8)
                    parameter_pps = parameter_packet(data + offset, nalu_len);
                is_sps = is_sps || stap_type == 7;
                is_pps = is_pps || stap_type == 8;
                stap_has_idr = stap_has_idr || stap_type == 5;
                offset += nalu_len;
            }
        }
        const bool is_idr_start = nal_type == 5 || stap_has_idr || (fu_start && fu_type == 5);
        const bool is_idr_packet = nal_type == 5 || stap_has_idr || (is_fu && fu_type == 5);
        // A FU end terminates one slice. Only the RTP marker completes the
        // access unit; high-resolution cameras can encode several IDR slices.
        const bool is_idr_end = is_idr_packet && (data[1] & 0x80);
        if (is_idr_end)
            notify_media_ready(true, false);
        const bool is_parameter_packet = is_sps || is_pps;

        {
            std::lock_guard<std::mutex> lock(param_mutex_);
            if (!parameter_sps.empty())
                sps_pkt_ = std::move(parameter_sps);
            if (!parameter_pps.empty())
                pps_pkt_ = std::move(parameter_pps);
        }
        const uint32_t timestamp = (uint32_t(data[4]) << 24) | (uint32_t(data[5]) << 16) |
                                   (uint32_t(data[6]) << 8) | data[7];
        if (collecting_idr_ && timestamp != current_idr_timestamp_) {
            collecting_idr_ = false;
            current_idr_pkts_.clear();
        }
        if (is_idr_start && !collecting_idr_) {
            collecting_idr_ = true;
            current_idr_timestamp_ = timestamp;
            current_idr_pkts_.clear();
            current_idr_bytes_ = 0;
            std::lock_guard<std::mutex> lock(param_mutex_);
            if (!sps_pkt_.empty())
                current_idr_pkts_.push_back(sps_pkt_);
            if (!pps_pkt_.empty())
                current_idr_pkts_.push_back(pps_pkt_);
        }
        if (collecting_idr_ && is_idr_packet) {
            current_idr_bytes_ += len;
            if (current_idr_bytes_ > 8 * 1024 * 1024 || current_idr_pkts_.size() >= 8192) {
                collecting_idr_ = false;
                current_idr_pkts_.clear();
                return;
            }
            current_idr_pkts_.emplace_back(data, data + len);
            if (is_idr_end) {
                collecting_idr_ = false;
                std::lock_guard<std::mutex> lock(idr_cache_mutex_);
                idr_cache_pkts_ = current_idr_pkts_;
            }
        }

        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto& [fd, session] : clients_) {
            if (!session.is_playing)
                continue;
            if (session.wait_idr) {
                if (is_idr_start)
                    session.wait_idr_started = true;
                if (is_parameter_packet || (is_idr_packet && session.wait_idr_started)) {
                    send_client_rtp_packet(fd, session, true, data, len);
                    if (is_idr_end && session.wait_idr_started)
                        session.wait_idr = false;
                }
                continue;
            }
            send_client_rtp_packet(fd, session, true, data, len);
        }
        return;
    }

    uint8_t nal_type = (data[12] >> 1) & 0x3F;
    std::vector<uint8_t> rtp_out;

    if (nal_type == 32 || nal_type == 33 || nal_type == 34) {
        // Parameter sets (VPS / SPS / PPS)
        {
            std::lock_guard<std::mutex> param_lock(param_mutex_);
            if (nal_type == 32) {
                vps_pkt_.assign(data, data + len);
                collecting_idr_ = true;
                current_idr_pkts_.clear();
            } else if (nal_type == 33) {
                sps_pkt_.assign(data, data + len);
            } else if (nal_type == 34) {
                pps_pkt_.assign(data, data + len);
            }
        }
        rtp_out.assign(data, data + len);
        if (collecting_idr_) {
            current_idr_pkts_.push_back(rtp_out);
        }
    } else if (nal_type == 30 || nal_type == 14) {
        // Fragmented HEVC packet from Tuya
        uint8_t fu_header = data[13];
        bool start_bit = (fu_header & 0x80) != 0;
        bool end_bit = (fu_header & 0x40) != 0;
        uint8_t real_nal = (nal_type == 30) ? 19 : 1;

        // Tuya FU layout differs slightly from RFC 7798. The first fragment
        // carries the original second HEVC NAL-header byte at data[14], while
        // continuation fragments begin payload at data[14]. We synthesize that
        // second header byte below, so it must be skipped only on FU start.
        size_t payload_offset = start_bit ? 15 : 14;
        if (len > payload_offset) {
            size_t payload_len = len - payload_offset;
            rtp_out.resize(15 + payload_len);
            // Copy 12-byte RTP header
            std::memcpy(rtp_out.data(), data, 12);
            // Standard RFC 7798 HEVC FU Header
            rtp_out[12] = 0x62;  // FU type 49, LayerId high = 0
            rtp_out[13] = 0x01;  // LayerId low = 0, TID = 1
            rtp_out[14] = (start_bit ? 0x80 : 0x00) | (end_bit ? 0x40 : 0x00) | (real_nal & 0x3F);
            std::memcpy(rtp_out.data() + 15, data + payload_offset, payload_len);
        }

        if (nal_type == 30 && collecting_idr_ && !rtp_out.empty()) {
            current_idr_pkts_.push_back(rtp_out);
            if (end_bit) {
                collecting_idr_ = false;
                std::lock_guard<std::mutex> lock(idr_cache_mutex_);
                idr_cache_pkts_ = current_idr_pkts_;
            }
        }
    } else {
        // Single NAL unit (e.g. NAL 1 unfragmented)
        rtp_out.assign(data, data + len);
    }

    if (rtp_out.empty())
        return;

    bool is_param_set = (nal_type == 32 || nal_type == 33 || nal_type == 34);
    bool is_idr_frag = (nal_type == 30);
    bool is_idr_start = is_idr_frag && ((data[13] & 0x80) != 0);
    bool is_idr_end = is_idr_frag && ((data[13] & 0x40) != 0);

    if (!collecting_idr_ && (is_idr_start || is_idr_end)) {
        // Either the IDR just finished (already cached) or we are mid-GOP; refresh snapshot
        if (is_idr_end)
            rebuild_snapshot_annexb();
    }

    std::lock_guard<std::mutex> lock(clients_mutex_);
    for (auto& [fd, session] : clients_) {
        if (!session.is_playing)
            continue;

        if (session.wait_idr) {
            if (is_idr_start) {
                // Send cached parameter sets (VPS, SPS, PPS) right before IDR so decoder is immediately primed
                std::lock_guard<std::mutex> plock(param_mutex_);
                if (!vps_pkt_.empty())
                    send_client_rtp_packet(fd, session, true, vps_pkt_.data(), vps_pkt_.size());
                if (!sps_pkt_.empty())
                    send_client_rtp_packet(fd, session, true, sps_pkt_.data(), sps_pkt_.size());
                if (!pps_pkt_.empty())
                    send_client_rtp_packet(fd, session, true, pps_pkt_.data(), pps_pkt_.size());
            }

            if (is_param_set || is_idr_frag) {
                send_client_rtp_packet(fd, session, true, rtp_out.data(), rtp_out.size());
                if (is_idr_end) {
                    session.wait_idr = false;  // Successfully synchronized on a clean keyframe!
                }
            }
            // Do not forward P-slices to clients waiting for an IDR
            continue;
        }

        // For synchronized clients, forward all frames
        send_client_rtp_packet(fd, session, true, rtp_out.data(), rtp_out.size());
    }
}

// PCMU G.711 μ-law silence byte = 0xFF (zero sample encoded)
static constexpr uint8_t kPcmuSilenceByte = 0xFF;
// 20 ms @ 8000 Hz = 160 samples for PCMU
static constexpr size_t kSilenceSamples = 160;
// How long to wait with no real audio before injecting silence (ms)
// Set to 400 ms so natural conversational pauses in speech are not chopped by silence injection
static constexpr int64_t kSilenceThresholdMs = 400;

void RTSPServer::silence_loop() {
    // This generator is PCMU/8 kHz only. An AAC/16 kHz relay must never emit
    // unadvertised PCMU packets while its first real audio frame is pending.
    if (audio_is_aac_)
        return;
    // Pre-build the fixed-size PCMU silence RTP packet payload (no header yet)
    // Header is filled per-client below using the client's unified session seq & ts.
    static constexpr size_t kPktSize = 12 + kSilenceSamples;
    std::array<uint8_t, kPktSize> pkt{};
    // RTP fixed header fields that never change
    pkt[0] = 0x80;         // V=2, no padding, no ext, CC=0
    pkt[1] = 0x80 | 0x00;  // Marker=1, PT=0 (PCMU)
    // SSRC – use the audio SSRC constant
    pkt[8] = 0x98;
    pkt[9] = 0x76;
    pkt[10] = 0x54;
    pkt[11] = 0x32;
    std::fill(pkt.begin() + 12, pkt.end(), kPcmuSilenceByte);

    while (running_) {
        // Sleep 20 ms (one PCMU frame interval)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        if (!running_)
            break;

        // Skip silence injection while real audio is flowing
        const int64_t now = steady_now_ms();
        const int64_t last = last_audio_feed_ms_.load(std::memory_order_relaxed);
        if (last != 0 && (now - last) < kSilenceThresholdMs) {
            continue;
        }

        // No real audio for kSilenceThresholdMs — inject silence to every playing client.
        // Once live audio has started for a session, never inject synthetic silence into it
        // to prevent non-monotonic DTS jumps and audible click artifacts.
        std::lock_guard<std::mutex> lock(clients_mutex_);
        if (clients_.empty()) {
            continue;
        }

        for (auto& [fd, session] : clients_) {
            if (!session.is_playing || session.has_audio_base_ts)
                continue;

            const uint16_t out_seq = session.out_audio_seq++;
            session.last_audio_out_ts += static_cast<uint32_t>(kSilenceSamples);
            const uint32_t out_ts = session.last_audio_out_ts;

            // Build RTP packet per client sharing session's unified monotonic seq & ts
            std::array<uint8_t, kPktSize> cpkt = pkt;
            cpkt[2] = (out_seq >> 8) & 0xFF;
            cpkt[3] = out_seq & 0xFF;
            cpkt[4] = (out_ts >> 24) & 0xFF;
            cpkt[5] = (out_ts >> 16) & 0xFF;
            cpkt[6] = (out_ts >> 8) & 0xFF;
            cpkt[7] = out_ts & 0xFF;

            send_interleaved_packet(fd, session.audio_rtp_channel, cpkt.data(), cpkt.size());
        }
    }
}

}  // namespace tuya
