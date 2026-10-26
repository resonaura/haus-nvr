#ifdef NDEBUG
#undef NDEBUG
#endif
#include "media/track_nack_responder.hpp"
#include <rtc/rtp.hpp>
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>

using rtc::binary;
using rtc::make_message;
using rtc::Message;
using rtc::message_ptr;
using rtc::message_vector;

static message_ptr packet(uint32_t ssrc, uint16_t sequence) {
    auto result = make_message(13, Message::Binary);
    auto* header = reinterpret_cast<rtc::RtpHeader*>(result->data());
    header->preparePacket();
    header->setSsrc(ssrc);
    header->setSeqNumber(sequence);
    header->setTimestamp(90000);
    header->setPayloadType(96);
    (*result)[12] = std::byte{0x61};
    return result;
}

static message_ptr nack(uint32_t ssrc, uint16_t sequence) {
    // Generic RTCP NACK: V=2, FMT=1, PT=205, 12-byte feedback header + one FCI.
    auto result = make_message(16, Message::Control);
    auto* bytes = reinterpret_cast<uint8_t*>(result->data());
    bytes[0] = 0x81;
    bytes[1] = 205;
    bytes[2] = 0;
    bytes[3] = 3;
    bytes[7] = 7; // The browser's own feedback SSRC is unrelated to either track.
    for (int i = 0; i < 4; i++) bytes[8 + i] = ssrc >> (24 - 8 * i);
    bytes[12] = sequence >> 8;
    bytes[13] = sequence;
    return result;
}

int main() {
    constexpr uint32_t video_ssrc = 0x10203040, audio_ssrc = 0x50607080;
#ifdef HAUS_UNFILTERED_FEEDBACK
    rtc::RtcpNackResponder video(8), audio(8);
#else
    tuya::TrackNackResponder video(video_ssrc, 8), audio(audio_ssrc, 8);
#endif
    const auto discard = [](message_ptr) {};
    message_vector video_packets{packet(video_ssrc, 100), packet(video_ssrc, 200)};
    message_vector audio_packets{packet(audio_ssrc, 100), packet(audio_ssrc, 200)};
    video.outgoing(video_packets, discard);
    audio.outgoing(audio_packets, discard);
    auto first = nack(video_ssrc, 100), second = nack(audio_ssrc, 200);
    auto compound = make_message(32, Message::Control);
    std::copy(first->begin(), first->end(), compound->begin());
    std::copy(second->begin(), second->end(), compound->begin() + 16);
    const binary original = *compound;
    message_vector incoming{compound};
    std::vector<message_ptr> retransmitted_video, retransmitted_audio;
    // The bundled transport sends the same compound control message to every
    // referenced track. RTP sequence numbers are independent for each track.
    video.incoming(incoming, [&](message_ptr p) { retransmitted_video.push_back(p); });
    audio.incoming(incoming, [&](message_ptr p) { retransmitted_audio.push_back(p); });
    std::cout << "compound NACK: video=" << retransmitted_video.size()
              << " audio=" << retransmitted_audio.size() << std::endl;
    assert(retransmitted_video.size() == 1 && retransmitted_audio.size() == 1);
    assert(reinterpret_cast<rtc::RtpHeader*>(retransmitted_video[0]->data())->seqNumber() == 100);
    assert(reinterpret_cast<rtc::RtpHeader*>(retransmitted_audio[0]->data())->seqNumber() == 200);
    assert(*compound == original && incoming.size() == 1);
#ifndef HAUS_UNFILTERED_FEEDBACK
    // A request for the other SSRC must not replay a same-numbered local packet.
    message_vector foreign{nack(audio_ssrc, 100)};
    video.incoming(foreign, [&](message_ptr p) { retransmitted_video.push_back(p); });
    assert(retransmitted_video.size() == 1);
    // BLP bit 0 adds sequence 101; a legitimate local retransmission remains.
    auto additional = packet(video_ssrc, 101);
    message_vector add{additional};
    video.outgoing(add, discard);
    auto bitmask = nack(video_ssrc, 100);
    (*bitmask)[15] = std::byte{1};
    message_vector request{bitmask};
    video.incoming(request, [&](message_ptr p) { retransmitted_video.push_back(p); });
    assert(retransmitted_video.size() == 3);
    // Reject bad lengths and non-NACK feedback without looping or emitting data.
    for (int kind = 0; kind < 4; kind++) {
        auto bad = nack(video_ssrc, 100);
        if (kind == 0) (*bad)[3] = std::byte{0};
        if (kind == 1) (*bad)[3] = std::byte{255};
        if (kind == 2) (*bad)[0] = std::byte{0x80};
        if (kind == 3) (*bad)[0] = std::byte{0x41};
        message_vector invalid{bad};
        video.incoming(invalid, [&](message_ptr p) { retransmitted_video.push_back(p); });
    }
    assert(retransmitted_video.size() == 3);
    // Legal final-member padding is removed before the FCI is interpreted.
    auto padded = make_message(20, Message::Control);
    std::copy(first->begin(), first->end(), padded->begin());
    (*padded)[0] = std::byte{0xa1};
    (*padded)[3] = std::byte{4};
    (*padded)[19] = std::byte{4};
    message_vector padded_request{padded};
    video.incoming(padded_request, [&](message_ptr p) { retransmitted_video.push_back(p); });
    assert(retransmitted_video.size() == 4);
    (*padded)[19] = std::byte{0};
    video.incoming(padded_request, [&](message_ptr p) { retransmitted_video.push_back(p); });
    assert(retransmitted_video.size() == 4);
    // Empty FCI is not a request, and a missing cached sequence emits nothing.
    auto empty = make_message(12, Message::Control);
    std::copy(first->begin(), first->begin() + 12, empty->begin());
    (*empty)[3] = std::byte{2};
    message_vector not_cached{nack(video_ssrc, 999), empty};
    video.incoming(not_cached, [&](message_ptr p) { retransmitted_video.push_back(p); });
    assert(retransmitted_video.size() == 4);
#endif
}
