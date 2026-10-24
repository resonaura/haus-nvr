#pragma once

#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <poll.h>
#include <sys/socket.h>
#include <sys/uio.h>

namespace tuya {

// A short TCP write must finish before another interleaved packet can start.
// Use a fixed deadline so a stalled local consumer cannot stop RTP ingestion.
inline bool write_interleaved_packet(int fd, uint8_t channel, const uint8_t* packet, size_t len,
                                     std::chrono::milliseconds timeout = std::chrono::milliseconds(250)) {
    if (fd < 0 || !packet || len == 0 || len > 0xffff)
        return false;

    const uint8_t header[4] = {'$', channel, static_cast<uint8_t>(len >> 8), static_cast<uint8_t>(len)};
    iovec vectors[2] = {{const_cast<uint8_t*>(header), sizeof(header)}, {const_cast<uint8_t*>(packet), len}};
    size_t first = 0;
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (first < 2) {
        if (std::chrono::steady_clock::now() >= deadline)
            return false;

        msghdr message{};
        message.msg_iov = vectors + first;
        message.msg_iovlen = 2 - first;
        const auto written = sendmsg(fd, &message, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (written > 0) {
            size_t remaining = static_cast<size_t>(written);
            while (first < 2 && remaining >= vectors[first].iov_len) {
                remaining -= vectors[first].iov_len;
                ++first;
            }
            if (first < 2 && remaining > 0) {
                vectors[first].iov_base = static_cast<uint8_t*>(vectors[first].iov_base) + remaining;
                vectors[first].iov_len -= remaining;
            }
            continue;
        }
        if (written == 0)
            return false;
        if (errno == EINTR)
            continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK)
            return false;

        const auto remaining = deadline - std::chrono::steady_clock::now();
        if (remaining <= std::chrono::steady_clock::duration::zero())
            return false;
        pollfd writable{fd, POLLOUT, 0};
        const auto remaining_ms = std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count();
        const int ready = poll(&writable, 1, static_cast<int>(remaining_ms + 1));
        if (ready < 0 && errno == EINTR)
            continue;
        if (ready <= 0 || (writable.revents & (POLLERR | POLLHUP | POLLNVAL)))
            return false;
    }
    return true;
}

}  // namespace tuya
