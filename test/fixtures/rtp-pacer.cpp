#include "media/rtp_pacer.hpp"
#include <cassert>
#include <chrono>
#include <thread>

int main() {
    using namespace std::chrono;
    tuya::RtpPacer video(true);
    auto start = steady_clock::now();
    // A detailed IDR arrives as one burst. It must not reach a browser UDP
    // socket in a single scheduler slice, and must not accumulate seconds of
    // latency. RTP timestamps/payloads are untouched by this sender gate.
    for (int packet = 0; packet < 240; ++packet)
        video.pace(1200, 9000);
    auto elapsed = steady_clock::now() - start;
    assert(elapsed >= 25ms && elapsed < 1s);

    // A detailed high-resolution keyframe can be large despite low average
    // bitrate. The old 12-Mbit gate took >500ms, starving WebRTC's decoder.
    tuya::RtpPacer detailed(true);
    start = steady_clock::now();
    for (int packet = 0; packet < 683; ++packet)
        detailed.pace(1200, 9000);
    elapsed = steady_clock::now() - start;
    assert(elapsed >= 90ms && elapsed < 450ms);

    std::this_thread::sleep_for(30ms);
    start = steady_clock::now();
    video.pace(1200, 18000);
    assert(steady_clock::now() - start < 50ms);

    tuya::RtpPacer audio(false);
    start = steady_clock::now();
    for (int packet = 0; packet < 12; ++packet)
        audio.pace(200, packet * 960);
    elapsed = steady_clock::now() - start;
    assert(elapsed >= 60ms && elapsed < 1s);
}
