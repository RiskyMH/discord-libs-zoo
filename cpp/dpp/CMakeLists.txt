cmake_minimum_required(VERSION 3.16)

project(dpp-honeypot LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)

# Build DPP statically so the Docker runtime only needs the system libraries.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build shared libraries" FORCE)
set(BUILD_VOICE_SUPPORT OFF CACHE BOOL "Build voice support" FORCE)
set(DPP_BUILD_TEST OFF CACHE BOOL "Build the test program" FORCE)
set(DPP_INSTALL OFF CACHE BOOL "Generate the install target" FORCE)

FetchContent_Declare(
  DPP
  GIT_REPOSITORY https://github.com/brainboxdotcc/DPP
  GIT_TAG v10.1.6
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(DPP)

find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)
find_package(SQLite3 REQUIRED)
find_library(ZSTD_LIBRARY NAMES zstd REQUIRED)

add_executable(honeypot src/main.cpp)

target_link_libraries(
  honeypot
  PRIVATE
  dpp
  OpenSSL::SSL
  OpenSSL::Crypto
  ZLIB::ZLIB
  SQLite::SQLite3
  ${ZSTD_LIBRARY}
)

install(TARGETS honeypot)
