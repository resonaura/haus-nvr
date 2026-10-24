#include <iostream>
#include <csignal>
#include <rtc/rtc.hpp>
#include "ipc/server.hpp"

int main() {
    // Ignore SIGPIPE so broken client sockets don't crash the server
    std::signal(SIGPIPE, SIG_IGN);

    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);

    const char* debug = std::getenv("DEBUG");
    rtc::InitLogger(debug && std::string(debug) == "1" ? rtc::LogLevel::Debug : rtc::LogLevel::Warning);

    tuya::IpcServer server;
    server.run_stdio();

    return 0;
}
