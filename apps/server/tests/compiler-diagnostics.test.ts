import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGxx } from '../src/config.js';
import { compileSource } from '../src/judge/compiler.js';

describe('compiler diagnostics', () => {
  it('never echoes the contents of an included file', async () => {
    const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'compiler-diag-'));
    const sourceDir = join(root, 'submissions', '2026', '11', 'run');
    mkdirSync(sourceDir, { recursive: true });
    const marker = 'S3CR3T_MARKER_abc123';
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ sessionSecret: marker }));
    const sourcePath = join(sourceDir, 'main.cpp');
    writeFileSync(sourcePath, '#include "../../../../secrets.json"\nint main() { return 0; }\n');
    try {
      const result = await compileSource({
        gxx: detectGxx(),
        sourcePath,
        outExe: join(root, 'prog.exe'),
        workdir: root,
        language: 'cpp17',
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(marker);
      expect(result.message).not.toContain('sessionSecret');
      expect(result.message.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('compiles C11 with gcc instead of g++', async () => {
    const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'compiler-c11-'));
    const sourcePath = join(root, 'main.cpp');
    writeFileSync(sourcePath, 'int main(void) { return 0; }\n');
    try {
      const result = await compileSource({
        gxx: detectGxx(),
        sourcePath,
        outExe: join(root, 'prog.exe'),
        workdir: root,
        language: 'c11',
        timeoutMs: 15_000,
      });
      expect(result.ok, result.message).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
