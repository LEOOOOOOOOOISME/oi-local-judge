// Phase 0 testlib SPJ fixture: never returns, used to test timeout -> SE.
// Usage (testlib protocol): checker <input> <output> <answer>
#include "testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    for (;;) {
    }
}
