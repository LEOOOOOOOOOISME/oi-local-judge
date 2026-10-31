// Phase 0 Lemon six-argument SPJ fixture.
// Usage (Lemon protocol): checker <input> <output> <answer> <full_score> <score_file> <info_file>
#include <cstdlib>
#include <fstream>
#include <string>

int main(int argc, char* argv[]) {
    if (argc < 7) {
        return 1;
    }

    std::ifstream fin(argv[1]);
    std::ifstream fout(argv[2]);
    std::ifstream fans(argv[3]);

    long long a = 0;
    long long b = 0;
    long long expected = 0;
    long long got = 0;

    if (!(fin >> a >> b) || !(fans >> expected) || !(fout >> got)) {
        std::ofstream scoreOut(argv[5]);
        scoreOut << "0\n";
        std::ofstream infoOut(argv[6]);
        infoOut << "invalid output\n";
        return 0;
    }

    const double full = std::atof(argv[4]);
    double score = 0.0;
    std::string info;

    if (got == expected) {
        score = full;
        info = "correct";
    } else if (std::llabs(got - expected) <= 1) {
        score = full * 0.5;
        info = "close enough for half credit";
    } else {
        info = "wrong answer";
    }

    std::ofstream scoreOut(argv[5]);
    scoreOut << score << "\n";
    std::ofstream infoOut(argv[6]);
    infoOut << info << "\n";
    return 0;
}
