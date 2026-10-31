#include "testlib.h"

int main(int argc, char *argv[]) {
    registerValidation(argc, argv);
    long long a = inf.readLong(-1000000LL, 1000000LL, "a");
    inf.readSpace();
    long long b = inf.readLong(-1000000LL, 1000000LL, "b");
    inf.readEoln();
    inf.readEof();
    if (a + b > 1000000LL) {
        quitf(_fail, "sum %lld is too large", a + b);
    }
}
