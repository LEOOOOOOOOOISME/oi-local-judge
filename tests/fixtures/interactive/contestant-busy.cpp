#include <cstdio>

int main() {
  volatile unsigned long long spin = 0;
  for (;;) {
    spin++;
  }
  return 0;
}
