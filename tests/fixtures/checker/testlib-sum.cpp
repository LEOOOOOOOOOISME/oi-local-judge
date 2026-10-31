// Phase 0 testlib SPJ fixture: A+B checker.
// Usage (testlib protocol): checker <input> <output> <answer>
#include "testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    long long a = inf.readLong();
    long long b = inf.readLong();
    long long expected = ans.readLong();
    long long got = ouf.readLong();

    if (got != expected) {
        quitf(_wa, "expected %lld, got %lld", expected, got);
    }
    quitf(_ok, "answer is correct");
}
