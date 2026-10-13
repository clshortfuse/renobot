#pragma once
#include <cstdint>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
#include "icc-data.h"

inline std::vector<uint8_t> embedProfile(const avifRWData& data) {
  std::vector<uint8_t> source(data.data, data.data + data.size);
  struct Box { size_t offset, size; std::string type; std::vector<size_t> parents; };
  std::vector<Box> boxes;
  auto integer = [&](size_t p, size_t n) -> uint64_t {
    if (n > 6 || p > source.size() || n > source.size() - p) throw std::runtime_error("Invalid AVIF offset");
    uint64_t v = 0;
    for (size_t i = 0; i < n; ++i) v = (v << 8) | source[p + i];
    return v;
  };
  auto put = [&](size_t p, size_t n, uint64_t v) {
    if (!n || n > 6 || p > source.size() || n > source.size() - p || v >= (uint64_t(1) << (8 * n)))
      throw std::runtime_error("AVIF offset overflow");
    for (size_t i = n; i > 0; --i) { source[p + i - 1] = uint8_t(v); v >>= 8; }
  };
  std::function<void(size_t, size_t, std::vector<size_t>)> scan;
  scan = [&](size_t start, size_t end, std::vector<size_t> parents) {
    for (size_t p = start; p < end;) {
      if (end - p < 8) throw std::runtime_error("Truncated AVIF box");
      const size_t size = size_t(integer(p, 4));
      if (size < 8 || size > end - p) throw std::runtime_error("Unsupported AVIF box");
      std::string type(reinterpret_cast<const char*>(source.data() + p + 4), 4);
      boxes.push_back({p, size, type, parents});
      if (type == "meta" || type == "iprp" || type == "ipco") {
        auto nested = parents; nested.push_back(p);
        scan(p + 8 + (type == "meta" ? 4 : 0), p + size, nested);
      }
      p += size;
    }
  };
  scan(0, source.size(), {});
  const Box* color = nullptr;
  for (const auto& box : boxes) if (box.type == "colr") { color = &box; break; }
  if (!color || color->size < 18 || std::memcmp(source.data() + color->offset + 8, "nclx", 4) ||
      integer(color->offset + 12, 2) != 9 || integer(color->offset + 14, 2) != 16)
    throw std::runtime_error("Expected primary BT.2020/PQ nclx");
  const size_t replacementSize = sizeof(hdrICC) + 12;
  const size_t delta = replacementSize - color->size;
  const size_t boundary = color->offset + color->size;
  for (auto parent : color->parents) put(parent, 4, integer(parent, 4) + delta);
  for (const auto& box : boxes) {
    if (box.type != "iloc") continue;
    size_t p = box.offset + 8;
    const auto version = integer(p, 1); p += 4;
    if (version > 2) throw std::runtime_error("Unsupported iloc version");
    const auto sizes = integer(p++, 1);
    const size_t offsetSize = sizes >> 4, lengthSize = sizes & 15;
    const auto baseSizes = integer(p++, 1);
    const size_t baseSize = baseSizes >> 4, indexSize = version ? baseSizes & 15 : 0;
    const size_t countSize = version < 2 ? 2 : 4;
    const auto count = integer(p, countSize); p += countSize;
    for (uint64_t i = 0; i < count; ++i) {
      p += version < 2 ? 2 : 4;
      uint64_t method = 0;
      if (version) { method = integer(p, 2) & 15; p += 2; }
      if (integer(p, 2) || method > 1) throw std::runtime_error("Unsupported item storage");
      p += 2;
      const size_t basePosition = p;
      const auto base = integer(p, baseSize); p += baseSize;
      const auto extents = integer(p, 2); p += 2;
      const bool shiftBase = method == 0 && baseSize && base >= boundary;
      if (shiftBase) put(basePosition, baseSize, base + delta);
      for (uint64_t j = 0; j < extents; ++j) {
        p += indexSize;
        const auto offset = integer(p, offsetSize);
        if (method == 0 && !shiftBase && base + offset >= boundary) put(p, offsetSize, offset + delta);
        p += offsetSize + lengthSize;
      }
      if (p > box.offset + box.size) throw std::runtime_error("Truncated item locations");
    }
  }
  std::vector<uint8_t> result;
  result.insert(result.end(), source.begin(), source.begin() + color->offset);
  for (int shift : {24, 16, 8, 0}) result.push_back(uint8_t(replacementSize >> shift));
  const char* type = "colrprof";
  result.insert(result.end(), type, type + 8);
  result.insert(result.end(), hdrICC, hdrICC + sizeof(hdrICC));
  result.insert(result.end(), source.begin() + boundary, source.end());
  return result;
}