#include <avif/avif.h>
#include <png.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// Input is host-endian RGB uint16, with normalized PQ samples (0..65535).
static int encode(const uint16_t* pixels, uint32_t width,
                  uint32_t height, avifRWData* output) {
  if (!pixels || !output || !width || !height || uint64_t(width) * height > 40000000) {
    return AVIF_RESULT_INVALID_ARGUMENT;
  }
  try {
    using Image = std::unique_ptr<avifImage, decltype(&avifImageDestroy)>;
    Image base(avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV444), avifImageDestroy);
    Image reference(avifImageCreate(width, height, 12, AVIF_PIXEL_FORMAT_YUV444), avifImageDestroy);
    if (!base || !reference) return AVIF_RESULT_OUT_OF_MEMORY;
    const size_t count = size_t(width) * height * 3;
    std::vector<uint8_t> primary(count);
    std::vector<uint16_t> alternate(count);
    for (size_t i = 0; i < count; ++i) {
      primary[i] = uint8_t((uint32_t(pixels[i]) + 128) / 257);
      alternate[i] = uint16_t((uint32_t(pixels[i]) * 4095 + 32767) / 65535);
    }
    for (avifImage* image : {base.get(), reference.get()}) {
      image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT2020;
      image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SMPTE2084;
      image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
      image->yuvRange = AVIF_RANGE_FULL;
      avifRGBImage rgb;
      avifRGBImageSetDefaults(&rgb, image);
      rgb.format = AVIF_RGB_FORMAT_RGB;
      rgb.depth = image->depth;
      rgb.pixels = image == base.get() ? primary.data() : reinterpret_cast<uint8_t*>(alternate.data());
      rgb.rowBytes = width * 3 * (image == base.get() ? 1 : 2);
      const avifResult result = avifImageRGBToYUV(image, &rgb);
      if (result != AVIF_RESULT_OK) return result;
    }
    base->gainMap = avifGainMapCreate();
    if (!base->gainMap) return AVIF_RESULT_OUT_OF_MEMORY;
    base->gainMap->image = avifImageCreate(std::max(1u, (width + 2) / 4),
                                           std::max(1u, (height + 2) / 4), 10, AVIF_PIXEL_FORMAT_YUV444);
    if (!base->gainMap->image) return AVIF_RESULT_OUT_OF_MEMORY;
    avifDiagnostics diagnostics{};
    avifResult result = avifImageComputeGainMap(base.get(), reference.get(), base->gainMap, &diagnostics);
    if (result != AVIF_RESULT_OK) return result;
    // The native helper inserts ICC without re-encoding, preserving the tested Discord
    // preview metadata layout. Gain-map computation requires no input ICC.
    std::unique_ptr<avifEncoder, decltype(&avifEncoderDestroy)> encoder(avifEncoderCreate(), avifEncoderDestroy);
    if (!encoder) return AVIF_RESULT_OUT_OF_MEMORY;
    encoder->quality = 85;
    encoder->qualityGainMap = 90;
    encoder->speed = 8;
    encoder->maxThreads = 2;
    encoder->autoTiling = AVIF_TRUE;
    return avifEncoderWrite(encoder.get(), base.get(), output);
  } catch (...) {
    return AVIF_RESULT_OUT_OF_MEMORY;
  }
}

static int Convert(const char* inputPath, const char* outputPath) {
  const auto started = std::chrono::steady_clock::now();
  if (inputPath && std::filesystem::file_size(inputPath) > 64 * 1024 * 1024) throw std::runtime_error("Input exceeds 64 MiB");
  FILE* input = inputPath ? std::fopen(inputPath, "rb") : stdin;
  if (!input) return 3;
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  png_infop info = png ? png_create_info_struct(png) : nullptr;
  if (!info) {
    if (png) png_destroy_read_struct(&png, nullptr, nullptr);
    if (inputPath) std::fclose(input);
    return 3;
  }
  if (setjmp(png_jmpbuf(png))) {
    png_destroy_read_struct(&png, &info, nullptr);
    if (inputPath) std::fclose(input);
    return 3;
  }
  png_set_user_limits(png, 40000000, 40000000);
  png_set_chunk_malloc_max(png, 1024 * 1024);
  struct Reader {
    FILE* input;
    size_t bytes;
  } reader{input, 0};
  png_set_read_fn(png, &reader, [](png_structp state, png_bytep destination, png_size_t count) {
    auto* reader = static_cast<Reader*>(png_get_io_ptr(state));
    if (count > 64 * 1024 * 1024 - reader->bytes) png_error(state, "Input exceeds 64 MiB");
    reader->bytes += count;
    if (std::fread(destination, 1, count, reader->input) != count) png_error(state, "Truncated PNG input");
  });
  png_read_info(png, info);
  const uint32_t width = png_get_image_width(png, info);
  const uint32_t height = png_get_image_height(png, info);
  const int depth = png_get_bit_depth(png, info);
  const int colorType = png_get_color_type(png, info);
  if (!width || !height || uint64_t(width) * height > 40000000 || (colorType != PNG_COLOR_TYPE_RGB && colorType != PNG_COLOR_TYPE_RGBA) || (depth != 8 && depth != 16)) {
    png_error(png, "Only RGB or opaque RGBA 8/16-bit PNGs within 40 million pixels are supported");
  }
  // No gamma, ICC, or transfer-function transform: preserve absolute PQ codes.
  png_read_update_info(png, info);
  auto rows = static_cast<png_bytepp>(png_malloc(png, size_t(height) * sizeof(png_bytep)));
  std::memset(rows, 0, size_t(height) * sizeof(png_bytep));
  png_set_rows(png, info, rows);
  png_data_freer(png, info, PNG_DESTROY_WILL_FREE_DATA, PNG_FREE_ROWS);
  for (uint32_t y = 0; y < height; ++y) rows[y] = static_cast<png_bytep>(png_malloc(png, png_get_rowbytes(png, info)));
  png_read_image(png, rows);
  png_read_end(png, info);
  const size_t channels = colorType == PNG_COLOR_TYPE_RGBA ? 4 : 3;
  if (channels == 4) {
    for (uint32_t y = 0; y < height; ++y) {
      for (size_t x = 0; x < width; ++x) {
        const size_t alpha = (x * 4 + 3) * (depth == 16 ? 2 : 1);
        if (rows[y][alpha] != 255 || (depth == 16 && rows[y][alpha + 1] != 255)) {
          png_error(png, "Transparent RGBA PNGs are not supported");
        }
      }
    }
  }
  std::vector<uint16_t> pixels(size_t(width) * height * 3);
  for (uint32_t y = 0; y < height; ++y) {
    for (size_t x = 0; x < size_t(width) * 3; ++x) {
      const size_t source = (x / 3) * channels + x % 3;
      pixels[size_t(y) * width * 3 + x] = depth == 16
                                              ? uint16_t((uint16_t(rows[y][2 * source]) << 8) | rows[y][2 * source + 1])
                                              : uint16_t(rows[y][source] * 257);
    }
  }
  png_destroy_read_struct(&png, &info, nullptr);
  if (inputPath) std::fclose(input);
  const auto decoded = std::chrono::steady_clock::now();
  avifRWData output = AVIF_DATA_EMPTY;
  const int result = encode(pixels.data(), width, height, &output);
  if (result != AVIF_RESULT_OK) {
    std::fprintf(stderr, "Conversion failed: %s\n", avifResultToString(avifResult(result)));
    avifRWDataFree(&output);
    return 4;
  }
  std::vector<uint8_t> tagged;
  try {
    // ICC v4 matrix-shaper profile. All fields are serialized big-endian.
    auto put_profile_integer = [](std::vector<uint8_t>* bytes, size_t offset, size_t count, uint32_t value) {
      for (size_t i = count; i > 0; --i) {
        (*bytes)[offset + i - 1] = static_cast<uint8_t>(value);
        value >>= 8;
      }
    };
    auto put_profile_text = [](std::vector<uint8_t>* bytes, size_t offset, const char* value) {
      std::memcpy(bytes->data() + offset, value, std::strlen(value));
    };
    auto make_xyz_tag = [&](const std::array<double, 3>& values) {
      std::vector<uint8_t> bytes(20);
      put_profile_text(&bytes, 0, "XYZ ");
      for (size_t i = 0; i < 3; ++i) {
        put_profile_integer(&bytes, 8 + i * 4, 4,
                            static_cast<uint32_t>(static_cast<int32_t>(std::round(values[i] * 65536))));
      }
      return bytes;
    };
    std::vector<uint8_t> curve(12 + 4096 * 2);
    put_profile_text(&curve, 0, "curv");
    put_profile_integer(&curve, 8, 4, 4096);
    for (size_t i = 0; i < 4096; ++i) {
      // ST 2084 EOTF, normalized to its absolute 10,000 cd/mÂ² endpoint.
      const double power = std::pow(static_cast<double>(i) / 4095, 32.0 / 2523);
      const double pq_ratio = std::fmax(power - 3424.0 / 4096, 0.0) / (2413.0 / 128 - 2392.0 / 128 * power);
      const double linear = std::pow(pq_ratio, 16384.0 / 2610);
      put_profile_integer(&curve, 12 + i * 2, 2, static_cast<uint32_t>(std::round(linear * 65535)));
    }
    constexpr char PROFILE_NAME[] = "Renobot BT.2020 PQ 203nit";
    std::vector<uint8_t> description(28 + (sizeof(PROFILE_NAME) - 1) * 2);
    put_profile_text(&description, 0, "mluc");
    put_profile_integer(&description, 8, 4, 1);
    put_profile_integer(&description, 12, 4, 12);
    put_profile_text(&description, 16, "enUS");
    put_profile_integer(&description, 20, 4, (sizeof(PROFILE_NAME) - 1) * 2);
    put_profile_integer(&description, 24, 4, 28);
    for (size_t i = 0; i < sizeof(PROFILE_NAME) - 1; ++i) {
      description[29 + i * 2] = static_cast<uint8_t>(PROFILE_NAME[i]);
    }
    std::vector<uint8_t> adaptation(44);
    put_profile_text(&adaptation, 0, "sf32");
    constexpr double BRADFORD[] = {
        1.047882,
        0.022919,
        -0.050201,
        0.029587,
        0.990479,
        -0.017059,
        -0.009232,
        0.015076,
        0.751678,
    };
    for (size_t i = 0; i < 9; ++i) {
      put_profile_integer(&adaptation, 8 + i * 4, 4,
                          static_cast<uint32_t>(static_cast<int32_t>(std::round(BRADFORD[i] * 65536))));
    }
    struct Tag {
      const char* name;
      std::vector<uint8_t> bytes;
    };
    // Bradford-adapted BT.2020 â†’ D50 columns, without luminance scaling.
    const std::vector<Tag> tags = {
        {.name = "desc", .bytes = description},
        {.name = "cprt", .bytes = description},
        {.name = "wtpt", .bytes = make_xyz_tag({0.9642, 1, 0.8249})},
        {.name = "chad", .bytes = adaptation},
        {.name = "cicp", .bytes = {'c', 'i', 'c', 'p', 0, 0, 0, 0, 9, 16, 0, 1}},
        {.name = "lumi", .bytes = make_xyz_tag({0, 203, 0})},
        {.name = "rXYZ", .bytes = make_xyz_tag({0.673459, 0.279033, -0.001931})},
        {.name = "gXYZ", .bytes = make_xyz_tag({0.165661, 0.675338, 0.029979})},
        {.name = "bXYZ", .bytes = make_xyz_tag({0.125100, 0.045629, 0.797162})},
        {.name = "rTRC", .bytes = curve},
        {.name = "gTRC", .bytes = curve},
        {.name = "bTRC", .bytes = curve},
    };
    std::vector<uint8_t> profile(132 + tags.size() * 12);
    put_profile_integer(&profile, 128, 4, static_cast<uint32_t>(tags.size()));
    for (size_t i = 0; i < tags.size(); ++i) {
      put_profile_text(&profile, 132 + i * 12, tags[i].name);
      put_profile_integer(&profile, 136 + i * 12, 4, static_cast<uint32_t>(profile.size()));
      put_profile_integer(&profile, 140 + i * 12, 4, static_cast<uint32_t>(tags[i].bytes.size()));
      profile.insert(profile.end(), tags[i].bytes.begin(), tags[i].bytes.end());
      profile.resize((profile.size() + 3) & ~size_t(3));
    }
    put_profile_integer(&profile, 0, 4, static_cast<uint32_t>(profile.size()));
    put_profile_integer(&profile, 8, 4, 0x04300000);
    put_profile_text(&profile, 12, "mntrRGB XYZ ");
    constexpr uint16_t PROFILE_DATE[] = {2026, 10, 13, 0, 0, 0};
    for (size_t i = 0; i < 6; ++i) {
      put_profile_integer(&profile, 24 + i * 2, 2, PROFILE_DATE[i]);
    }
    put_profile_text(&profile, 36, "acsp");
    const auto white = make_xyz_tag({0.9642, 1, 0.8249});
    std::memcpy(profile.data() + 68, white.data() + 8, 12);
    put_profile_text(&profile, 80, "Reno");
    // Bytes 84..99: optional ICC profile ID, zero means not calculated.

    std::vector<uint8_t> source(output.data, output.data + output.size);
    struct Box {
      size_t offset;
      size_t size;
      std::string type;
      std::vector<size_t> parents;
    };
    std::vector<Box> boxes;
    auto read_integer = [&](size_t offset, size_t count) -> uint64_t {
      if (count > 6 || offset > source.size() || count > source.size() - offset) {
        throw std::runtime_error("Invalid AVIF offset");
      }
      uint64_t value = 0;
      for (size_t i = 0; i < count; ++i) {
        value = (value << 8) | source[offset + i];
      }
      return value;
    };
    auto put_integer = [&](size_t offset, size_t count, uint64_t value) {
      if (!count || count > 6 || offset > source.size() || count > source.size() - offset || value >= (uint64_t(1) << (8 * count))) {
        throw std::runtime_error("AVIF offset overflow");
      }
      for (size_t i = count; i > 0; --i) {
        source[offset + i - 1] = static_cast<uint8_t>(value);
        value >>= 8;
      }
    };
    // The recursive lambda needs its callable declared before capturing it.
    std::function<void(size_t, size_t, std::vector<size_t>)> scan_boxes;
    scan_boxes = [&](size_t start, size_t end, std::vector<size_t> parents) {
      for (size_t offset = start; offset < end;) {
        if (end - offset < 8) throw std::runtime_error("Truncated AVIF box");
        const size_t size = static_cast<size_t>(read_integer(offset, 4));
        if (size < 8 || size > end - offset) throw std::runtime_error("Unsupported AVIF box");
        std::string type(reinterpret_cast<const char*>(source.data() + offset + 4), 4);
        boxes.push_back({.offset = offset, .size = size, .type = type, .parents = parents});
        if (type == "meta" || type == "iprp" || type == "ipco") {
          auto nested_parents = parents;
          nested_parents.push_back(offset);
          scan_boxes(offset + 8 + (type == "meta" ? 4 : 0), offset + size, nested_parents);
        }
        offset += size;
      }
    };
    scan_boxes(0, source.size(), {});
    const Box* color = nullptr;
    for (const auto& box : boxes) {
      if (box.type == "colr") {
        color = &box;
        break;
      }
    }
    if (!color || color->size < 18 || std::memcmp(source.data() + color->offset + 8, "nclx", 4) || read_integer(color->offset + 12, 2) != 9 || read_integer(color->offset + 14, 2) != 16) {
      throw std::runtime_error("Expected primary BT.2020/PQ nclx");
    }
    const size_t replacement_size = profile.size() + 12;
    const size_t delta = replacement_size - color->size;
    const size_t boundary = color->offset + color->size;
    for (auto parent : color->parents) {
      put_integer(parent, 4, read_integer(parent, 4) + delta);
    }
    for (const auto& box : boxes) {
      if (box.type != "iloc") continue;
      size_t offset = box.offset + 8;
      const auto version = read_integer(offset, 1);
      offset += 4;
      if (version > 2) throw std::runtime_error("Unsupported iloc version");
      const auto sizes = read_integer(offset++, 1);
      const size_t offset_size = sizes >> 4;
      const size_t length_size = sizes & 15;
      const auto base_sizes = read_integer(offset++, 1);
      const size_t base_size = base_sizes >> 4;
      const size_t index_size = (version ? (base_sizes & 15) : 0);
      const size_t count_size = (version < 2 ? 2 : 4);
      const auto count = read_integer(offset, count_size);
      offset += count_size;
      for (uint64_t i = 0; i < count; ++i) {
        offset += (version < 2 ? 2 : 4);
        uint64_t method = 0;
        if (version) {
          method = read_integer(offset, 2) & 15;
          offset += 2;
        }
        if (read_integer(offset, 2) || method > 1) throw std::runtime_error("Unsupported item storage");
        offset += 2;
        const size_t base_position = offset;
        const auto base = read_integer(offset, base_size);
        offset += base_size;
        const auto extents = read_integer(offset, 2);
        offset += 2;
        const bool shift_base = method == 0 && base_size && base >= boundary;
        if (shift_base) {
          put_integer(base_position, base_size, base + delta);
        }
        for (uint64_t j = 0; j < extents; ++j) {
          offset += index_size;
          const auto extent_offset = read_integer(offset, offset_size);
          if (method == 0 && !shift_base && base + extent_offset >= boundary) {
            put_integer(offset, offset_size, extent_offset + delta);
          }
          offset += offset_size + length_size;
        }
        if (offset > box.offset + box.size) throw std::runtime_error("Truncated item locations");
      }
    }
    tagged.insert(tagged.end(), source.begin(), source.begin() + color->offset);
    for (int shift : {24, 16, 8, 0}) {
      tagged.push_back(static_cast<uint8_t>(replacement_size >> shift));
    }
    constexpr char COLOR_TYPE[] = "colrprof";
    tagged.insert(tagged.end(), COLOR_TYPE, COLOR_TYPE + 8);
    tagged.insert(tagged.end(), profile.begin(), profile.end());
    tagged.insert(tagged.end(), source.begin() + boundary, source.end());
  } catch (...) {
    avifRWDataFree(&output);
    throw;
  }
  FILE* file = outputPath ? std::fopen(outputPath, "wbx") : stdout;
  bool written = false;
  if (file) {
    written = std::fwrite(tagged.data(), 1, tagged.size(), file) == tagged.size();
    if (outputPath ? std::fclose(file) != 0 : std::fflush(file) != 0) written = false;
  }
  avifRWDataFree(&output);
  if (!written) return 5;
  std::fprintf(outputPath ? stdout : stderr, "decode_ms=%.1f convert_encode_ms=%.1f\n",
               std::chrono::duration<double, std::milli>(decoded - started).count(),
               std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - decoded).count());
  return 0;
}

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--stdio") == 0) {
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 3;
#endif
    try {
      return Convert(nullptr, nullptr);
    } catch (const std::exception& error) {
      std::fprintf(stderr, "%s\n", error.what());
      return 1;
    }
  }
  if (argc == 4 && std::strcmp(argv[1], "--output") == 0) {
    try {
      return Convert(argv[3], argv[2]);
    } catch (const std::exception& error) {
      std::fprintf(stderr, "%s\n", error.what());
      return 1;
    }
  }
  if (argc < 2) {
    std::fprintf(stderr, "Drop one or more BT.2020/PQ PNGs onto this executable.\n");
    return 2;
  }
  int status = 0;
  for (int i = 1; i < argc; ++i) {
    try {
      auto output = std::filesystem::path(argv[i]);
      output.replace_filename(output.stem().string() + "_hdr.avif");
      const int result = Convert(argv[i], output.string().c_str());
      std::fprintf(result ? stderr : stdout, "%s: %s\n", argv[i], result ? "Conversion failed" : output.string().c_str());
      if (result) status = result;
    } catch (const std::exception& error) {
      std::fprintf(stderr, "%s: %s\n", argv[i], error.what());
      status = 1;
    }
  }
  return status;
}