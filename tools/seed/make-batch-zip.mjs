// Generates demo contestant archives for the local batch judging UI.
//
// Outputs (gitignored runtime data):
//   runtime/test-data/batch-demo.zip          Alice/main.cpp, Bob/main.cpp, ...
//   runtime/test-data/batch-demo-wrapped.zip  submissions/Alice/main.cpp, ...
//   runtime/test-data/batch-demo/             unpacked sources + expected-results.txt
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const contestants = {
  Alice: `#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << a + b << "\\n";
    return 0;
}
`,
  Bob: `#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << a + b + 1 << "\\n";
    return 0;
}
`,
  Carol: `#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    volatile long long x = 0;
    while (true) {
        x = x + 1;
    }
    return 0;
}
`,
  Dave: `#include <iostream>
int main() {
    long long a, b
    std::cin >> a >> b;
    std::cout << a + b << "\\n";
    return 0;
}
`,
  Eve: `#include <cstdio>
int main() {
    long long a = 0, b = 0;
    if (std::scanf("%lld%lld", &a, &b) != 2) return 1;
    std::printf("%lld\\n", a + b);
    return 0;
}
`,
  Frank: `#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    volatile int zero = 0;
    std::cout << (a + b) / zero << "\\n";
    return 0;
}
`,
};

const root = join(process.cwd(), 'runtime', 'test-data');
rmSync(join(root, 'batch-demo'), { recursive: true, force: true });
mkdirSync(join(root, 'batch-demo'), { recursive: true });

const flat = {};
const wrapped = {};
for (const [name, source] of Object.entries(contestants)) {
  mkdirSync(join(root, 'batch-demo', name), { recursive: true });
  writeFileSync(join(root, 'batch-demo', name, 'main.cpp'), source, 'utf8');
  const bytes = new TextEncoder().encode(source);
  flat[`${name}/main.cpp`] = bytes;
  wrapped[`submissions/${name}/main.cpp`] = bytes;
}

const expected = `题目：A+B Problem（题号 1，2 个测试点，各 50 分）

Alice   AC    100  cin/cout 正确
Bob     WA    0    a+b+1
Carol   TLE   0    死循环
Dave    CE    0    缺分号
Eve     AC    100  scanf/printf
Frank   RE    0    除零

上传 batch-demo.zip，层级选第 1 层，比赛/题目选 A+B Problem。
上传 batch-demo-wrapped.zip，层级选第 2 层（根目录 submissions/ 包了一层）。
`;
writeFileSync(join(root, 'batch-demo', 'expected-results.txt'), expected, 'utf8');
writeFileSync(join(root, 'batch-demo.zip'), Buffer.from(zipSync(flat, { level: 6 })));
writeFileSync(join(root, 'batch-demo-wrapped.zip'), Buffer.from(zipSync(wrapped, { level: 6 })));
console.log('created', join(root, 'batch-demo.zip'));
console.log('created', join(root, 'batch-demo-wrapped.zip'));
console.log('sources', join(root, 'batch-demo'));
