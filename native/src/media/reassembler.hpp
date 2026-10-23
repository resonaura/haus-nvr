#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <functional>
#include <mutex>
#include <memory>

namespace tuya {

struct MediaFrame {
    bool is_video = true;
    bool is_keyframe = false;
    uint32_t timestamp_ms = 0;
    uint32_t codec_fourcc = 0;
    std::vector<uint8_t> data;
};

class AVIOReassembler {
public:
    using FrameCallback = std::function<void(const MediaFrame&)>;

    AVIOReassembler();
    ~AVIOReassembler();

    void set_frame_callback(FrameCallback cb);
    void feed_packet(uint8_t channel, uint16_t seq, const uint8_t* payload, size_t len);
    void reset();

private:
    struct FragmentBuffer {
        uint32_t total_size = 0;
        uint32_t expected_frags = 0;
        uint32_t received_bytes = 0;
        uint32_t timestamp_ms = 0;
        uint32_t codec_fourcc = 0;
        bool is_keyframe = false;
        std::vector<uint8_t> data;
    };

    void process_frame(bool is_video, bool is_keyframe, uint32_t timestamp_ms, uint32_t codec_fourcc,
                       const uint8_t* payload, size_t len);

    FrameCallback callback_;
    std::mutex mutex_;

    FragmentBuffer video_buffer_;
    FragmentBuffer audio_buffer_;
};

}  // namespace tuya
