import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const scripts = ['sqlite-bench.mjs', 'ranking-bench.mjs', 'runner-bench.mjs'];
const result = {};
for (const script of scripts) {
  const out = execFileSync(process.execPath, [join(process.cwd(), 'tools/bench', script)], {
    encoding: 'utf8',
  });
  result[script.replace('.mjs', '')] = JSON.parse(out.trim());
}
console.log(JSON.stringify(result, null, 2));
