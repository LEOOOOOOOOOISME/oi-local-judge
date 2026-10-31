// Tries to allocate 128 MB in 1 MB chunks while touching every page, so the
// job ProcessMemoryLimit is exercised by real committed-memory growth (a single
// huge allocation could fail without the peak ever approaching the limit).
#include <cstdio>
#include <vector>

int main() {
  const std::size_t chunk = 1u << 20;
  std::vector<char*> blocks;
  blocks.reserve(128);
  for (int i = 0; i < 128; ++i) {
    char* p = new char[chunk];
    for (std::size_t off = 0; off < chunk; off += 4096) {
      p[off] = static_cast<char>(i);
    }
    blocks.push_back(p);
  }
  std::puts("allocated 128MB");
  return 0;
}
