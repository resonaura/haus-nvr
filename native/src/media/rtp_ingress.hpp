#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <sys/socket.h>
#include <sys/uio.h>

namespace tuya {

// FFmpeg emits a compressed frame as a burst, not at the average stream bitrate.
// Keep a bounded queue large enough for a high-resolution frame and a brief
// scheduler stall. Kernels may cap the request, so report the effective value.
inline int configure_rtp_receive_buffer(int fd, bool video) {
    for (int bytes = video ? 8 * 1024 * 1024 : 1024 * 1024; bytes >= 256 * 1024; bytes /= 2) {
        if (setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &bytes, sizeof(bytes)) == 0)
            break;
    }
#ifdef SO_RXQ_OVFL
    int enabled = 1;
    setsockopt(fd, SOL_SOCKET, SO_RXQ_OVFL, &enabled, sizeof(enabled));
#endif
    int effective = 0;
    socklen_t length = sizeof(effective);
    getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &effective, &length);
    return effective;
}

struct RtpIngressStats {
    uint64_t packets = 0;
    uint64_t bytes = 0;
    uint64_t sequence_gaps = 0;
    uint64_t kernel_drops = 0;
    uint64_t truncated = 0;
    int receive_buffer_bytes = 0;
};

class RtpIngress {
public:
    explicit RtpIngress(int fd, bool video) {
        stats.receive_buffer_bytes = configure_rtp_receive_buffer(fd, video);
    }

    ssize_t receive(int fd, uint8_t* data, size_t capacity) {
        std::array<std::byte, 128> control{};
        iovec iov{data, capacity};
        msghdr message{};
        message.msg_iov = &iov;
        message.msg_iovlen = 1;
        message.msg_control = control.data();
        message.msg_controllen = control.size();
        const auto length = recvmsg(fd, &message, 0);
        gap = false;
        if (length <= 0)
            return length;
#ifdef SO_RXQ_OVFL
        for (auto* header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
            if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SO_RXQ_OVFL &&
                header->cmsg_len >= CMSG_LEN(sizeof(uint32_t))) {
                uint32_t drops = 0;
                std::memcpy(&drops, CMSG_DATA(header), sizeof(drops));
                stats.kernel_drops = drops;
            }
        }
#endif
        if (message.msg_flags & MSG_TRUNC) {
            ++stats.truncated;
            return 0;
        }
        if (length < 12 || (data[0] >> 6) != 2)
            return 0;
        const uint16_t sequence = (static_cast<uint16_t>(data[2]) << 8) | data[3];
        if (has_sequence) {
            const uint16_t delta = sequence - last_sequence;
            if (delta > 0 && delta < 0x8000) {
                gap = delta > 1;
                stats.sequence_gaps += delta - 1;
                last_sequence = sequence;
            }
        } else {
            has_sequence = true;
            last_sequence = sequence;
        }
        ++stats.packets;
        stats.bytes += static_cast<uint64_t>(length);
        return length;
    }

    bool report_due() {
        const auto now = std::chrono::steady_clock::now();
        if (now - last_report < std::chrono::seconds(15))
            return false;
        last_report = now;
        return true;
    }

    RtpIngressStats stats;
    bool gap = false;

private:
    bool has_sequence = false;
    uint16_t last_sequence = 0;
    std::chrono::steady_clock::time_point last_report = std::chrono::steady_clock::now();
};

}  // namespace tuya
