#pragma once

#include <cstdint>

namespace tuya {

/**
 * Tuya Media & P2P Protocol Command Types
 */
enum class TuyaCmdType : uint32_t {
    HEARTBEAT = 0x0009,          // Keepalive heartbeat ping
    HEARTBEAT_ACK = 0x000A,      // Keepalive heartbeat pong
    STREAM_START_REQ = 0x0020,   // Request live stream session
    STREAM_START_RESP = 0x0021,  // Live stream session response
    KEYFRAME_REQ = 0x0022,       // Request instant IDR keyframe
    KEYFRAME_RESP = 0x0023,      // Keyframe response
    PTZ_CONTROL = 0x0024,        // Pan / Tilt / Zoom control
    STREAM_STOP = 0x0025,        // Stop live stream session
    SET_QUALITY = 0x0026,        // HD / SD quality switch
};

/**
 * Tuya Packet Header Structure:
 *  - 4 bytes (BE): Prefix (0x000055AA or 0x00006699)
 *  - 4 bytes (BE): Sequence number
 *  - 4 bytes (BE): Command ID
 *  - 4 bytes (BE): Payload length
 *  - N bytes: Payload (AES-128 encrypted or plaintext JSON)
 *  - 4 bytes (BE): CRC32 / HMAC
 *  - 4 bytes (BE): Suffix (0x0000AA55 or 0x00009966)
 */
constexpr uint32_t TUYA_PREFIX = 0x000055AA;
constexpr uint32_t TUYA_SUFFIX = 0x0000AA55;
constexpr uint32_t TUYA_PREFIX_34 = 0x00006699;
constexpr uint32_t TUYA_SUFFIX_34 = 0x00009966;

}  // namespace tuya
