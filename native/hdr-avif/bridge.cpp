#include <avif/avif.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#include <png.h>
#include <cstdio>
#include <chrono>
#include <filesystem>
#include "profile.h"
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// Input is host-endian RGB uint16, with normalized PQ samples (0..65535).
static int encode(const uint16_t* pixels, uint32_t width,
                  uint32_t height, avifRWData* output) {
  if (!pixels || !output || !width || !height ||
      uint64_t(width) * height > 40000000) {
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
    // Node inserts ICC without re-encoding, preserving the tested Discord
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

static int convert(const char* inputPath, const char* outputPath) {
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
  struct Reader { FILE* input; size_t bytes; } reader{input, 0};
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
  if (!width || !height || uint64_t(width) * height > 40000000 ||
      png_get_color_type(png, info) != PNG_COLOR_TYPE_RGB || (depth != 8 && depth != 16)) {
    png_error(png, "Only RGB 8/16-bit PNGs within 40 million pixels are supported");
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
  std::vector<uint16_t> pixels(size_t(width) * height * 3);
  for (uint32_t y = 0; y < height; ++y) {
    for (size_t x = 0; x < size_t(width) * 3; ++x) {
      pixels[size_t(y) * width * 3 + x] = depth == 16
          ? uint16_t((uint16_t(rows[y][2 * x]) << 8) | rows[y][2 * x + 1])
          : uint16_t(rows[y][x] * 257);
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
  try { tagged = embedProfile(output); }
  catch (...) { avifRWDataFree(&output); throw; }
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
    try { return convert(nullptr, nullptr); }
    catch (const std::exception& error) {
      std::fprintf(stderr, "%s\n", error.what());
      return 1;
    }
  }
  if (argc == 4 && std::strcmp(argv[1], "--output") == 0) {
    try { return convert(argv[3], argv[2]); }
    catch (const std::exception& error) {
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
      const int result = convert(argv[i], output.string().c_str());
      std::fprintf(result ? stderr : stdout, "%s: %s\n", argv[i], result ? "Conversion failed" : output.string().c_str());
      if (result) status = result;
    } catch (const std::exception& error) {
      std::fprintf(stderr, "%s: %s\n", argv[i], error.what());
      status = 1;
    }
  }
  return status;
}