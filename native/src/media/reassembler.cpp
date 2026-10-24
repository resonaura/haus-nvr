#include "reassembler.hpp"
#include <cstring>
#include <iostream>

namespace tuya {

static inline uint16_t load16_le(const uint8_t* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

static inline uint32_t load32_le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

AVIOReassembler::AVIOReassembler() = default;

AVIOReassembler::~AVIOReassembler() = default;

void AVIOReassembler::set_frame_callback(FrameCallback cb) {
    std::lock_guard<std::mutex> lock(mutex_);
    callback_ = cb;
}

void AVIOReassembler::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    video_buffer_.data.clear();
    video_buffer_.received_bytes = 0;
    audio_buffer_.data.clear();
    audio_buffer_.received_bytes = 0;
}

void AVIOReassembler::feed_packet(uint8_t channel, uint16_t /*seq*/, const uint8_t* payload, size_t len) {
    if (len < 16)
        return;

    std::lock_guard<std::mutex> lock(mutex_);

    bool is_video = (channel == 1);
    bool is_audio = (channel == 2);

    if (!is_video && !is_audio)
        return;

    auto& buf = is_video ? video_buffer_ : audio_buffer_;

    // Parse packet header
    uint16_t frag_idx = load16_le(payload + 0);
    uint16_t total_frags = load16_le(payload + 2);
    uint32_t timestamp_ms = load32_le(payload + 4);
    uint32_t codec_fourcc = load32_le(payload + 8);
    uint32_t total_frame_size = load32_le(payload + 12);

    const uint8_t* data = payload + 16;
    size_t data_len = len - 16;

    if (frag_idx == 0) {
        buf.data.clear();
        buf.data.reserve(total_frame_size);
        buf.total_size = total_frame_size;
        buf.expected_frags = total_frags;
        buf.received_bytes = 0;
        buf.timestamp_ms = timestamp_ms;
        buf.codec_fourcc = codec_fourcc;
        // Keyframe detection (NAL 19/20/32 for HEVC or 5 for H264)
        buf.is_keyframe = (is_video && (data_len > 4 && ((data[4] & 0x7E) >> 1 == 19 || (data[4] & 0x7E) >> 1 == 20 ||
                                                         (data[4] & 0x7E) >> 1 == 32 || (data[4] & 0x1F) == 5)));
    }

    buf.data.insert(buf.data.end(), data, data + data_len);
    buf.received_bytes += data_len;

    if (buf.data.size() >= buf.total_size || static_cast<uint32_t>(frag_idx + 1) == buf.expected_frags) {
        process_frame(is_video, buf.is_keyframe, buf.timestamp_ms, buf.codec_fourcc, buf.data.data(), buf.data.size());
        buf.data.clear();
        buf.received_bytes = 0;
    }
}

void AVIOReassembler::process_frame(bool is_video, bool is_keyframe, uint32_t timestamp_ms, uint32_t codec_fourcc,
                                    const uint8_t* payload, size_t len) {
    if (!callback_)
        return;

    MediaFrame frame;
    frame.is_video = is_video;
    frame.is_keyframe = is_keyframe;
    frame.timestamp_ms = timestamp_ms;
    frame.codec_fourcc = codec_fourcc;
    frame.data.assign(payload, payload + len);

    callback_(frame);
}

}  // namespace tuya
