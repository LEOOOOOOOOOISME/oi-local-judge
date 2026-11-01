import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource } from '../apps/server/dist/judge/compiler.js';
import { loadConfig } from '../apps/server/dist/config.js';

// Usage: npm run build && node tools/bench-compile.mjs [total] [concurrency]
const config = loadConfig();
const total = Math.max(1, Number(process.argv[2] ?? 50));
const concurrency = Math.max(1, Number(process.argv[3] ?? 8));
const root = mkdtempSync(join(config.dataDir, 'tmp', 'bench-compile-'));
const sources = [];
for (let i = 0; i < total; i++) {
  const sourcePath = join(root, `s${i}.cpp`);
  writeFileSync(
    sourcePath,
    `#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1+${i}<<"\\n";}\n`,
  );
  sources.push({ sourcePath, outExe: join(root, `s${i}.exe`), workdir: root });
}
const started = Date.now();
let next = 0;
let ok = 0;
const failures = [];
async function worker() {
  while (true) {
    const index = next++;
    if (index >= total) return;
    const result = await compileSource({
      gxx: config.gxx,
      ...sources[index],
      language: 'cpp17',
      staticLink: true,
    });
    if (result.ok) ok++;
    else failures.push(result.message);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedMs = Date.now() - started;
console.log(
  JSON.stringify({
    total,
    concurrency,
    ok,
    failed: total - ok,
    elapsedMs,
    perSecond: Math.round((total / elapsedMs) * 1000),
  }),
);
if (failures.length) console.log(failures.slice(0, 2).join('\n'));
rmSync(root, { recursive: true, force: true });
