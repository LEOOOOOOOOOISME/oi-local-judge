// Phase 0 testlib SPJ fixture: exercises quitp() partial score.
// Usage (testlib protocol): checker <input> <output> <answer>
#include "testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    long long a = inf.readLong();
    long long b = inf.readLong();
    long long expected = ans.readLong();
    long long got = ouf.readLong();

    if (got == expected) {
        quitf(_ok, "answer is correct");
    }
    quitp(0.5, "half credit: expected %lld, got %lld", expected, got);
}
