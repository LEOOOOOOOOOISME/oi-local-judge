#include <fstream>
#include <iostream>

int main(int argc, char **argv) {
    std::ifstream in(argv[1]);
    long long n = 0;
    in >> n;
    std::cout << n << "\n" << std::flush;
    long long answer = -1;
    if (!(std::cin >> answer)) return 2;
    if (answer == n + 1) return 0;
    return 1;
}
