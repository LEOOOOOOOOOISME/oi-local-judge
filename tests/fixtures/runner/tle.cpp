// Infinite CPU-bound loop: must be killed by the wall-clock watchdog.
int main() {
  volatile unsigned long long counter = 0;
  for (;;) {
    counter = counter + 1;
  }
}
