cmake_minimum_required(VERSION 3.24)
project(renobot_hdr LANGUAGES C CXX)
get_filename_component(REPOSITORY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(AVIF_CODEC_AOM LOCAL CACHE STRING "" FORCE)
set(AVIF_LIBYUV OFF CACHE STRING "" FORCE)
set(AVIF_ZLIBPNG LOCAL CACHE STRING "" FORCE)
set(AVIF_BUILD_APPS OFF CACHE BOOL "" FORCE)
if(NOT EXISTS "${REPOSITORY_ROOT}/external/libavif/CMakeLists.txt")
  message(FATAL_ERROR "Initialize dependencies with git submodule update --init --recursive")
endif()
add_subdirectory("${REPOSITORY_ROOT}/external/libavif" "${CMAKE_CURRENT_BINARY_DIR}/libavif")
add_executable(renobot_hdr bridge.cpp)
set_target_properties(renobot_hdr PROPERTIES OUTPUT_NAME discord_hdr)
find_program(NODE_EXECUTABLE NAMES node REQUIRED)
add_custom_command(
  OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/icc-data.h"
  COMMAND "${NODE_EXECUTABLE}" "${REPOSITORY_ROOT}/scripts/generate-hdr-profile.js"
    "${CMAKE_CURRENT_BINARY_DIR}/icc-data.h"
  DEPENDS "${REPOSITORY_ROOT}/scripts/generate-hdr-profile.js"
    "${REPOSITORY_ROOT}/src/hdr-profile.js"
  VERBATIM)
target_sources(renobot_hdr PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/icc-data.h")
target_include_directories(renobot_hdr PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_features(renobot_hdr PRIVATE cxx_std_17)
target_link_libraries(renobot_hdr PRIVATE avif PNG::PNG ZLIB::ZLIB)
install(TARGETS renobot_hdr RUNTIME DESTINATION bin)