#include "rtsp/interleaved-writer.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <csignal>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace std::chrono_literals;

static std::array<int, 2> sockets() {
    std::array<int, 2> pair{};
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair.data()) == 0);
    int small_buffer = 1024;
    assert(setsockopt(pair[0], SOL_SOCKET, SO_SNDBUF, &small_buffer, sizeof(small_buffer)) == 0);
    timeval send_timeout{};
    send_timeout.tv_usec = 10000;
    assert(setsockopt(pair[0], SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout)) == 0);
    return pair;
}

int main() {
    std::vector<uint8_t> packet(60000);
    for (size_t i = 0; i < packet.size(); ++i)
        packet[i] = static_cast<uint8_t>(i);

    // An intentionally small TCP send buffer forces short writes. The reader
    // starts late and consumes small pieces, exercising EAGAIN and poll too.
    auto pair = sockets();
    std::vector<uint8_t> received;
    received.reserve(packet.size() + 4);
    std::thread reader([&]() {
        std::this_thread::sleep_for(20ms);
        uint8_t chunk[733];
        while (received.size() < packet.size() + 4) {
            const auto count = recv(pair[1], chunk, sizeof(chunk), 0);
            if (count <= 0)
                break;
            received.insert(received.end(), chunk, chunk + count);
        }
    });
    assert(tuya::write_interleaved_packet(pair[0], 2, packet.data(), packet.size(), 1000ms));
    shutdown(pair[0], SHUT_WR);
    reader.join();
    assert(received.size() == packet.size() + 4);
    assert(received[0] == '$' && received[1] == 2);
    assert((size_t(received[2]) << 8 | received[3]) == packet.size());
    assert(std::equal(packet.begin(), packet.end(), received.begin() + 4));
    close(pair[0]);
    close(pair[1]);

    // A consumer that never reads must release the ingestion thread promptly,
    // even after it accepted only the beginning of an interleaved packet.
    pair = sockets();
    const auto started = std::chrono::steady_clock::now();
    assert(!tuya::write_interleaved_packet(pair[0], 0, packet.data(), packet.size(), 40ms));
    const auto elapsed = std::chrono::steady_clock::now() - started;
    assert(elapsed >= 30ms && elapsed < 500ms);
    close(pair[0]);
    close(pair[1]);

    // A closed consumer must fail without SIGPIPE terminating the media worker.
    pair = sockets();
    close(pair[1]);
    assert(!tuya::write_interleaved_packet(pair[0], 0, packet.data(), packet.size()));
    close(pair[0]);

    assert(!tuya::write_interleaved_packet(-1, 0, packet.data(), packet.size()));
}
