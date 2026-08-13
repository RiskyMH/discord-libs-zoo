cmake_minimum_required(VERSION 3.25.1)

project(meowlib-honeypot)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(MEOWLIB_USE_INSTALLED
  "Use installed meowHttp/MeowLib instead of fetching from git (Docker build)"
  OFF)

if(MEOWLIB_USE_INSTALLED)
  find_package(nlohmann_json REQUIRED)
  find_package(SQLite3 REQUIRED)
  find_package(OpenSSL REQUIRED)
  find_package(MeowLib CONFIG REQUIRED)
else()
  list(PREPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

  include(FetchContent)
  set(FETCHCONTENT_QUIET OFF)

  find_package(nlohmann_json REQUIRED)
  find_package(SQLite3 REQUIRED)
  find_package(OpenSSL REQUIRED)

  FetchContent_Declare(
    meowHttp
    GIT_REPOSITORY https://git.girlsmell.xyz/luna/http-client.git
    GIT_TAG main
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(meowHttp)

  FetchContent_Declare(
    MeowLib
    GIT_REPOSITORY https://git.girlsmell.xyz/luna/MeowLib.git
    GIT_TAG main
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(MeowLib)
  # The installed MeowLib exposes headers under <MeowLib/...>, but the in-tree
  # checkout keeps them flat. Mirror the installed layout so both builds use
  # the same includes.
  set(MEOWLIB_ALIAS_INCLUDE "${CMAKE_CURRENT_BINARY_DIR}/include_alias")
  if(NOT EXISTS "${MEOWLIB_ALIAS_INCLUDE}/MeowLib")
    file(MAKE_DIRECTORY "${MEOWLIB_ALIAS_INCLUDE}")
    file(CREATE_LINK "${meowlib_SOURCE_DIR}/include" "${MEOWLIB_ALIAS_INCLUDE}/MeowLib" SYMBOLIC)
  endif()
endif()

file(GLOB_RECURSE src CONFIGURE_DEPENDS "./src/*.cpp")

add_executable(honeypot ${src})

if(MEOWLIB_ALIAS_INCLUDE)
  target_include_directories(honeypot PRIVATE "${MEOWLIB_ALIAS_INCLUDE}")
endif()

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  target_compile_options(honeypot PRIVATE -Wall -Werror -O1 -g -fsanitize=address)
  target_link_options(honeypot PRIVATE -fsanitize=address)
else()
  target_compile_options(honeypot PRIVATE -Wall -Wextra -Werror -O3)
endif()

target_link_libraries(honeypot PRIVATE MeowLib SQLite::SQLite3)
install(TARGETS honeypot)
