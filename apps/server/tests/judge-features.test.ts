import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { importProblemDirectory } from '../src/services/problems.js';
import { submitSource } from '../src/services/submissions.js';
import { createProblem, getTestcases } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { getTestResults, getSubmission } from '../src/storage/repos/submissions.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'judge-features-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const userId = createUser(db, { username: 'alice', passwordHash: 'x' });

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function judgeCode(problemId: number, code: string) {
  const { id } = submitSource(
    { db, config },
    { userId, problemId, language: 'cpp17', code, contestId: null },
  );
  return judgeSubmission({ db, config, submissionId: id }).then(() => ({
    submission: getSubmission(db, id)!,
    results: getTestResults(db, id),
  }));
}

describe('judge features', () => {
  it('supports file IO problems', async () => {
    const problemId = importProblemDirectory({
      db,
      config,
      sourceDir: join(process.cwd(), 'tests/fixtures/problems/file-io'),
    });
    const ac = await judgeCode(
      problemId,
      `#include <fstream>
       int main(){std::ifstream in("sum.in");std::ofstream out("sum.out");long long a,b;in>>a>>b;out<<a+b<<"\\n";}`,
    );
    expect(ac.submission.verdict, ac.submission.message).toBe('AC');
    expect(ac.submission.score).toBe(100);

    const missingFile = await judgeCode(
      problemId,
      `#include <iostream>
       int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`,
    );
    expect(missingFile.submission.verdict, missingFile.submission.message).toBe('WA');
    expect(missingFile.results[0].message).toContain('output file sum.out is missing');
  }, 20_000);

  it('wires a testlib special judge with partial score', async () => {
    const problemId = importProblemDirectory({
      db,
      config,
      sourceDir: join(process.cwd(), 'tests/fixtures/problems/spj-testlib'),
    });
    const ac = await judgeCode(
      problemId,
      `#include <iostream>
       int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`,
    );
    expect(ac.submission.verdict, ac.submission.message).toBe('AC');
    expect(ac.submission.score).toBe(100);

    const partial = await judgeCode(
      problemId,
      `#include <iostream>
       int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}`,
    );
    expect(partial.submission.verdict, partial.submission.message).toBe('PC');
    expect(partial.submission.score).toBe(50);    expect(partial.results[0].verdict).toBe('PC');
    expect(partial.results[0].score).toBe(50);
    expect(partial.results[0].message).toContain('expected 3');
  }, 30_000);

  it('skips a testcase whose dependency failed', async () => {
    mkdirSync(join(root, 'deps'), { recursive: true });
    writeFileSync(join(root, 'deps', '1.in'), '1 2\n');
    writeFileSync(join(root, 'deps', '1.out'), '3\n');
    writeFileSync(join(root, 'deps', '2.in'), '2 3\n');
    writeFileSync(join(root, 'deps', '2.out'), '5\n');
    const problemId = createProblem(db, {
      title: 'deps',
      type: 'standard',
      timeMs: 5000,
      memoryMb: 64,
      testcases: [
        { inputPath: join(root, 'deps', '1.in'), outputPath: join(root, 'deps', '1.out'), points: 50 },
        { inputPath: join(root, 'deps', '2.in'), outputPath: join(root, 'deps', '2.out'), points: 50 },
      ],
    });
    const [first, second] = getTestcases(db, problemId);
    db.prepare('UPDATE problem_testcases SET depends_on = ? WHERE id = ?').run(
      String(first.id),
      second.id,
    );

    const result = await judgeCode(
      problemId,
      `#include <iostream>
       int main(){long long a,b;std::cin>>a>>b;std::cout<<(a+b+1)<<"\\n";}`,
    );
    expect(result.results[0].verdict).toBe('WA');
    expect(result.results[1].verdict).toBe('SK');
    expect(result.submission.score).toBe(0);
  }, 20_000);
});
