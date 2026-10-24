#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>

namespace tuya {

// An FFmpeg reader gets fresh random RTP origins when it reconnects. The
// browser's SSRC and SRTP context live longer than that reader, so their RTP
// sequence/timestamp space must not jump back to a different publisher's
// origin. Within one publisher preserve packet gaps, reordering and media-clock
// deltas.
class RtpContinuity {
public:
  using Clock = std::chrono::steady_clock;
  struct Packet {
    uint16_t sequence;
    uint32_t timestamp;
  };

  explicit RtpContinuity(uint32_t clock_rate) : clock_rate_(clock_rate) {}

  Packet map(uint32_t source, uint16_t sequence, uint32_t timestamp,
             Clock::time_point now = Clock::now()) {
    if (!initialized_) {
      initialized_ = true;
      source_ = source;
      last_sequence_ = sequence;
      latest_timestamp_ = timestamp;
      last_packet_at_ = now;
    } else if (source != source_) {
      sequence_offset_ = static_cast<uint16_t>(last_sequence_ + 1 - sequence);
      const double elapsed =
          std::chrono::duration<double>(now - last_packet_at_).count();
      const auto ticks = static_cast<uint32_t>(
          std::clamp(elapsed * clock_rate_, 1.0, 30.0 * clock_rate_));
      timestamp_offset_ = latest_timestamp_ + ticks - timestamp;
      source_ = source;
      ++restarts_;
    }
    Packet packet{static_cast<uint16_t>(sequence + sequence_offset_),
                  timestamp + timestamp_offset_};
    if (static_cast<int16_t>(packet.sequence - last_sequence_) > 0) {
      last_sequence_ = packet.sequence;
      last_packet_at_ = now;
      if (static_cast<int32_t>(packet.timestamp - latest_timestamp_) > 0)
        latest_timestamp_ = packet.timestamp;
    }
    return packet;
  }

  uint64_t restarts() const { return restarts_; }

private:
  const uint32_t clock_rate_;
  bool initialized_ = false;
  uint32_t source_ = 0;
  uint16_t sequence_offset_ = 0;
  uint32_t timestamp_offset_ = 0;
  uint16_t last_sequence_ = 0;
  uint32_t latest_timestamp_ = 0;
  Clock::time_point last_packet_at_{};
  uint64_t restarts_ = 0;
};

} // namespace tuya
