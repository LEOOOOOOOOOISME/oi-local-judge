import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectGxx, loadConfig } from '../src/config.js';
import { ensureCompiledProgram } from '../src/judge/compile-cache.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'compile-cache-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
const sourcePath = join(root, 'main.cpp');
writeFileSync(sourcePath, '#include <iostream>\nint main(){std::cout<<"ok";}');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('compiled program cache', () => {
  it('compiles once and reuses the cached executable', async () => {
    const options = {
      gxx: detectGxx(),
      dataDir: root,
      sourcePath,
      language: 'cpp17',
    };
    const first = await ensureCompiledProgram(options);
    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);
    const second = await ensureCompiledProgram(options);
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.exe).toBe(first.exe);
    expect(config.dataDir).toBe(root);
  }, 60_000);
});
