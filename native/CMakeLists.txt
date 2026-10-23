cmake_minimum_required(VERSION 3.16)
project(haus_camera_media VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(NO_MEDIA OFF CACHE BOOL "" FORCE)
set(USE_NICE OFF CACHE BOOL "" FORCE)
set(USE_GNUTLS OFF CACHE BOOL "" FORCE)
set(USE_OPENSSL ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(
  glaze
  URL https://github.com/stephenberry/glaze/archive/refs/tags/v4.4.2.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(
  LibDataChannel
  GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
  GIT_TAG v0.22.3
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(glaze LibDataChannel)

add_executable(
  haus-camera-media
  src/crypto/aes.cpp
  src/media/reassembler.cpp
  src/rtsp/server.cpp
  src/p2p/cipher.cpp
  src/p2p/client.cpp
  src/webrtc/peer.cpp
  src/webrtc/browser_peer.cpp
  src/ipc/server.cpp
  src/session.cpp
  src/main.cpp
)
target_include_directories(haus-camera-media PRIVATE src ${glaze_SOURCE_DIR}/include)
target_link_libraries(haus-camera-media PRIVATE glaze::glaze LibDataChannel::LibDataChannel pthread)
