#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <thread>

namespace tuya {

// Copying one encoded frame must not flood the browser's UDP receive queue.
// Spread its packets without changing payloads, RTP clocks or camera quality.
// The floor is well above ordinary source bitrate; higher-bitrate sources
// increase the budget from their media clock instead of growing a stale queue.
class RtpPacer {
public:
    explicit RtpPacer(bool video)
        : minimum_bps_(video ? 12000000 : 256000),
          clock_rate_(video ? 90000 : 48000),
          bits_per_second_(minimum_bps_) {}

    void pace(size_t bytes, uint32_t timestamp) {
        if (!has_window_) {
            window_timestamp_ = timestamp;
            has_window_ = true;
        }
        const uint32_t elapsed = timestamp - window_timestamp_;
        if (elapsed >= clock_rate_ && elapsed < clock_rate_ * 10) {
            const auto measured = window_bytes_ * 8 * clock_rate_ / elapsed;
            bits_per_second_ = std::clamp<uint64_t>(measured * 2, minimum_bps_, 100000000);
            window_timestamp_ = timestamp;
            window_bytes_ = 0;
        } else if (elapsed >= clock_rate_ * 10) {
            window_timestamp_ = timestamp;
            window_bytes_ = 0;
        }
        window_bytes_ += bytes;
        const auto now = std::chrono::steady_clock::now();
        if (next_packet_ > now)
            std::this_thread::sleep_until(next_packet_);
        const auto interval = std::chrono::nanoseconds((bytes * 8ULL * 1000000000 + bits_per_second_ - 1) / bits_per_second_);
        next_packet_ = std::max(next_packet_, std::chrono::steady_clock::now()) + interval;
    }

private:
    const uint64_t minimum_bps_;
    const uint32_t clock_rate_;
    uint64_t bits_per_second_;
    std::chrono::steady_clock::time_point next_packet_{};
    bool has_window_ = false;
    uint32_t window_timestamp_ = 0;
    uint64_t window_bytes_ = 0;
};

} // namespace tuya
