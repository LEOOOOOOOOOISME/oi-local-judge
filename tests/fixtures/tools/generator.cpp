#include <cstdlib>
#include <iostream>

int main(int argc, char **argv) {
    long long seed = argc > 1 ? std::atoll(argv[1]) : 1;
    std::cout << seed << " " << seed + 1 << "\n";
}
