#include "testlib.h"

int main(int argc, char *argv[]) {
    registerTestlibCmd(argc, argv);
    long long a = inf.readLong();
    long long b = inf.readLong();
    long long expected = a + b;
    long long got = ouf.readLong(0, 1000000000000000000LL);
    if (got == expected) {
        quitf(_ok, "answer is %lld", got);
    }
    quitp(0.5, "expected %lld, got %lld", expected, got);
}
