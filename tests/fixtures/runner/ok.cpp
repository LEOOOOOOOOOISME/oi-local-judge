// Normal program: reads "a b" from stdin (redirection check) and prints the sum.
#include <cstdio>

int main() {
  int a = 0;
  int b = 0;
  if (std::scanf("%d %d", &a, &b) == 2) {
    std::printf("%d\n", a + b);
  } else {
    std::puts("ok");
  }
  return 0;
}
