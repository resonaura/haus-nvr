#pragma once

#include <rtc/rtc.hpp>
#include <algorithm>
#include <cstddef>
#include <cstdint>

namespace tuya {

// libdatachannel forwards one complete bundled RTCP compound to each referenced
// track. Its sequence-only retransmission cache otherwise answers a different
// track's NACK when their independent RTP sequence numbers happen to overlap.
class TrackNackResponder final : public rtc::MediaHandler {
public:
    TrackNackResponder(uint32_t ssrc, size_t max_packets)
        : ssrc_(ssrc), responder_(max_packets) {}

    void outgoing(rtc::message_vector& messages, const rtc::message_callback& send) override {
        responder_.outgoing(messages, send);
    }

    void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
        rtc::message_vector feedback;
        for (const auto& message : messages) {
            if (message->type != rtc::Message::Control) continue;
            const auto* data = reinterpret_cast<const uint8_t*>(message->data());
            size_t offset = 0;
            while (message->size() - offset >= 4) {
                const auto* header = data + offset;
                const size_t length = (size_t(header[2]) * 256 + header[3] + 1) * 4;
                if ((header[0] >> 6) != 2 || length < 4 || length > message->size() - offset)
                    break;
                if (header[1] == 205 && (header[0] & 0x1f) == 1 && length >= 16) {
                    const uint32_t target = (uint32_t(header[8]) << 24) |
                                            (uint32_t(header[9]) << 16) |
                                            (uint32_t(header[10]) << 8) | header[11];
                    size_t nack_length = length;
                    if (header[0] & 0x20) {
                        // RTCP padding belongs only to the final compound member.
                        const size_t padding = header[length - 1];
                        if (offset + length != message->size() || padding == 0 ||
                            padding % 4 != 0 || padding > length - 12)
                            break;
                        nack_length -= padding;
                    }
                    if (target == ssrc_ && nack_length >= 16) {
                        auto packet = rtc::make_message(nack_length, rtc::Message::Control);
                        std::copy(message->begin() + offset, message->begin() + offset + nack_length,
                                  packet->begin());
                        auto* bytes = reinterpret_cast<uint8_t*>(packet->data());
                        bytes[0] &= ~0x20;
                        const auto words = nack_length / 4 - 1;
                        bytes[2] = words >> 8;
                        bytes[3] = words;
                        feedback.push_back(std::move(packet));
                    }
                }
                offset += length;
            }
        }
        // Leave reports/PLI/the original compound untouched for other handlers.
        responder_.incoming(feedback, send);
    }

private:
    const uint32_t ssrc_;
    rtc::RtcpNackResponder responder_;
};

} // namespace tuya
