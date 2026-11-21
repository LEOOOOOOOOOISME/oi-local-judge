#include <cstdio>

int main() {
  static char buffer[8192];
  for (int i = 0; i < 8192; ++i) buffer[i] = 'x';
  for (;;) {
    std::fwrite(buffer, 1, sizeof(buffer), stdout);
  }
}
