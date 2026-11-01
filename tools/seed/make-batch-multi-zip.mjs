// Generates a multi-problem-per-student batch archive.
//
// Layout:
//   Alice/1/main.cpp   Alice/3/main.cpp
//   Bob/1/main.cpp     Bob/3/main.cpp
//   ...
// Problem folders are numeric database IDs (1 = A+B, 3 = A-B).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const plus = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}
`;
const minus = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a-b<<"\\n";}
`;
const wrongPlus = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}
`;
const wrongMinus = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}
`;
const tle = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;volatile long long x=0;while(true)x++;}
`;
const ce = `#include <iostream>
int main(){long long a,b std::cin>>a>>b;std::cout<<a+b;}
`;
const re = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;volatile int z=0;std::cout<<(a-b)/z;}
`;

const submissions = [
  ['Alice', '1', plus],
  ['Alice', '3', minus],
  ['Bob', '1', wrongPlus],
  ['Bob', '3', wrongMinus],
  ['Carol', '1', tle],
  ['Carol', '3', minus],
  ['Dave', '1', ce],
  ['Dave', '3', re],
  ['Eve', '1', plus],
];

const root = join(process.cwd(), 'runtime', 'test-data');
rmSync(join(root, 'batch-multi'), { recursive: true, force: true });
mkdirSync(join(root, 'batch-multi'), { recursive: true });

const flat = {};
const wrapped = {};
for (const [student, problem, source] of submissions) {
  const relative = `${student}/${problem}/main.cpp`;
  mkdirSync(join(root, 'batch-multi', student, problem), { recursive: true });
  writeFileSync(join(root, 'batch-multi', relative), source, 'utf8');
  const bytes = new TextEncoder().encode(source);
  flat[relative] = bytes;
  wrapped[`submissions/${relative}`] = bytes;
}

const expected = `多题批量评测（每个选手目录下有多个题目）

题目：1 = A+B Problem，3 = A-B Problem

Alice  1 AC 100 / 3 AC 100
Bob    1 WA 0   / 3 WA 0
Carol  1 TLE 0  / 3 AC 100
Dave   1 CE 0   / 3 RE 0
Eve    1 AC 100 / 3 缺失（不提交）

使用 batch-multi.zip：学生层级=1，题目层级=2。
使用 batch-multi-wrapped.zip：学生层级=2，题目层级=3。
`;
writeFileSync(join(root, 'batch-multi', 'expected-results.txt'), expected, 'utf8');
writeFileSync(join(root, 'batch-multi.zip'), Buffer.from(zipSync(flat, { level: 6 })));
writeFileSync(
  join(root, 'batch-multi-wrapped.zip'),
  Buffer.from(zipSync(wrapped, { level: 6 })),
);
console.log('created', join(root, 'batch-multi.zip'));
console.log('created', join(root, 'batch-multi-wrapped.zip'));
console.log('sources', join(root, 'batch-multi'));
