#include "media/rtp_continuity.hpp"
#include "media/rtp_ingress.hpp"
#include <array>
#include <cassert>
#include <chrono>
#include <sys/socket.h>
#include <unistd.h>

int main() {
  using namespace std::chrono;
  const auto start = tuya::RtpContinuity::Clock::time_point{};
  tuya::RtpContinuity video(90000);
  auto initial = video.map(11, 65534, 0xfffffff0, start);
  assert(initial.sequence == 65534 && initial.timestamp == 0xfffffff0);
  auto fragment = video.map(11, 65535, 0xfffffff0, start + 1ms);
  assert(fragment.sequence == 65535 && fragment.timestamp == initial.timestamp);
  auto wrapped = video.map(11, 0, 4484, start + 50ms);
  assert(wrapped.sequence == 0 &&
         wrapped.timestamp - initial.timestamp == 4500);
  auto gap = video.map(11, 3, 8984, start + 100ms);
  assert(gap.sequence == 3 && gap.timestamp - wrapped.timestamp == 4500);
  auto reordered = video.map(11, 2, 4484, start + 101ms);
  assert(reordered.sequence == 2 && reordered.timestamp == wrapped.timestamp);

  // The browser keeps the old SSRC/SRTP context. A new reader must continue
  // that sequence, despite a lower source sequence and random media origin.
  auto restarted = video.map(22, 50000, 1234, start + 600ms);
  assert(restarted.sequence == 4);
  assert(restarted.timestamp - gap.timestamp == 45000);
  auto same_picture = video.map(22, 50001, 1234, start + 601ms);
  assert(same_picture.sequence == 5 &&
         same_picture.timestamp == restarted.timestamp);
  auto following = video.map(22, 50002, 5734, start + 650ms);
  assert(following.sequence == 6 &&
         following.timestamp - restarted.timestamp == 4500);
  auto second_restart = video.map(33, 5, 0xfffffff0, start + 1150ms);
  assert(second_restart.sequence == 7 &&
         second_restart.timestamp - following.timestamp == 45000);
  assert(video.restarts() == 2);

  tuya::RtpContinuity audio(48000);
  const auto first_audio = audio.map(44, 100, 1000, start);
  const auto next_audio = audio.map(44, 101, 1960, start + 20ms);
  assert(next_audio.timestamp - first_audio.timestamp == 960);
  const auto restarted_audio = audio.map(55, 0, 4000000000U, start + 520ms);
  assert(restarted_audio.sequence == 102);
  assert(restarted_audio.timestamp - next_audio.timestamp == 24000);

  // Real loopback ingress must not count a new publisher's random sequence
  // origin as network loss. A hole within that publisher still is loss.
  int sockets[2];
  assert(socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets) == 0);
  tuya::RtpIngress ingress(sockets[1], true);
  const auto receive = [&](uint8_t source, uint16_t sequence) {
    std::array<uint8_t, 13> packet{};
    packet[0] = 0x80;
    packet[1] = 96;
    packet[2] = sequence >> 8;
    packet[3] = sequence;
    packet[11] = source;
    assert(send(sockets[0], packet.data(), packet.size(), 0) ==
           static_cast<ssize_t>(packet.size()));
    assert(ingress.receive(sockets[1], packet.data(), packet.size()) ==
           static_cast<ssize_t>(packet.size()));
  };
  receive(1, 10);
  receive(1, 11);
  receive(2, 30000);
  assert(ingress.stats.sequence_gaps == 0 &&
         ingress.stats.source_restarts == 1);
  receive(2, 30003);
  assert(ingress.stats.sequence_gaps == 2 &&
         ingress.stats.source_restarts == 1);
  close(sockets[0]);
  close(sockets[1]);
}
