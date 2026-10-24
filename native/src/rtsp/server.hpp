#pragma once

#include <chrono>
#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include <netinet/in.h>
#include "../media/reassembler.hpp"
#include "../media/rtp_ingress.hpp"

namespace tuya {

struct RTSPClientSession {
    int socket_fd = -1;
    std::string session_id;
    bool is_playing = false;
    bool wait_idr = true;
    bool wait_idr_started = false;
    uint8_t video_rtp_channel = 0;
    uint8_t video_rtcp_channel = 1;
    uint8_t audio_rtp_channel = 2;
    uint8_t audio_rtcp_channel = 3;
    uint16_t video_seq = 0;
    uint16_t audio_seq = 0;
    bool sent_gop = false;

    // Client-specific normalized sequence and timestamp tracking (anchored to RTP-Info)
    uint16_t out_video_seq = 0;
    uint16_t out_audio_seq = 0;

    std::chrono::steady_clock::time_point play_start_time{};
    bool play_started = false;

    // Video frame grouping (all RTP packets of the same video frame share the same timestamp)
    bool has_last_in_video_ts = false;
    uint32_t last_in_video_ts = 0;
    uint32_t current_frame_video_ts = 0x10000000;

    // Audio timestamp tracking
    bool has_audio_base_ts = false;
    uint32_t in_audio_base_ts = 0;
    uint32_t last_in_audio_ts = 0;
    uint32_t last_audio_out_ts = 0x20000000;

    static constexpr uint32_t out_base_video_ts = 0x10000000;
    static constexpr uint32_t out_base_audio_ts = 0x20000000;
};

class RTSPServer {
public:
    using KeyframeCallback = std::function<void()>;

    RTSPServer(int port, const std::string& path, KeyframeCallback kf_cb = nullptr, bool is_hevc = true,
               bool audio_is_aac = false);
    ~RTSPServer();

    bool start();
    bool start_udp_ingest(int video_port, int audio_port = 0);
    void stop();
    void notify_video_discontinuity();

    void feed_frame(const MediaFrame& frame);
    void feed_raw_rtp(const uint8_t* data, size_t len, bool is_video);

    int get_port() const { return port_; }
    const std::string& get_path() const { return path_; }

    void set_snapshot_callback(std::function<void(const std::vector<uint8_t>&)> cb);
    void set_media_ready_callback(std::function<void()> cb);
    void set_ingest_stats_callback(std::function<void(bool, const RtpIngressStats&)> cb);
    std::vector<uint8_t> get_latest_annexb() const;
    void clear_snapshot_annexb();

private:
    void accept_loop();
    void udp_ingest_loop(int socket_fd, bool is_video);
    void client_loop(int client_fd);
    void handle_rtsp_request(int client_fd, const std::string& req, RTSPClientSession& session);

    void send_interleaved_packet(int fd, uint8_t channel, const uint8_t* rtp_data, size_t len);
    void send_client_rtp_packet(int fd, RTSPClientSession& session, bool is_video, const uint8_t* data, size_t len);
    void packetize_and_send_video(const uint8_t* nalu, size_t len, uint32_t ts_90k, bool is_key);
    void packetize_and_send_audio(const uint8_t* data, size_t len, uint32_t ts_samples);
    void rebuild_snapshot_annexb();
    void notify_media_ready(bool video, bool audio);

    int port_;
    std::string path_;
    KeyframeCallback kf_req_cb_;
    bool is_hevc_ = true;
    bool audio_is_aac_ = false;
    int server_fd_ = -1;
    int udp_fd_ = -1;
    int audio_udp_fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread accept_thread_;
    std::thread udp_thread_;
    std::thread audio_udp_thread_;
    std::mutex client_threads_mutex_;
    std::vector<std::thread> client_threads_;

    std::mutex clients_mutex_;
    std::unordered_map<int, RTSPClientSession> clients_;

    // In-band parameter sets
    std::vector<uint8_t> vps_;
    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;

    // Cached raw parameter RTP packets
    std::mutex param_mutex_;
    std::vector<uint8_t> vps_pkt_;
    std::vector<uint8_t> sps_pkt_;
    std::vector<uint8_t> pps_pkt_;

    // Instant Keyframe / IDR caching
    std::mutex idr_cache_mutex_;
    std::vector<std::vector<uint8_t>> idr_cache_pkts_;
    std::vector<std::vector<uint8_t>> current_idr_pkts_;
    bool collecting_idr_ = false;

    // Last decodable keyframe in Annex-B (HEVC) form for snapshots
    mutable std::mutex snap_mutex_;
    std::vector<uint8_t> snapshot_annexb_;
    std::function<void(const std::vector<uint8_t>&)> snap_cb_;
    std::function<void()> media_ready_cb_;
    std::function<void(bool, const RtpIngressStats&)> ingest_stats_cb_;
    std::atomic<bool> media_video_ready_{false};
    std::atomic<bool> media_audio_ready_{false};
    std::atomic<bool> media_ready_sent_{false};

    // GOP caching
    std::mutex gop_mutex_;
    std::vector<MediaFrame> gop_cache_;
    bool has_keyframe_ = false;

    // Audio silence generation: inject PCMU silence when no real audio arrives
    std::atomic<int64_t> last_audio_feed_ms_{0};
    std::thread silence_thread_;
    void silence_loop();
};

}  // namespace tuya
