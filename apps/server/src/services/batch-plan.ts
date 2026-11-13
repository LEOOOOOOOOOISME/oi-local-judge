import type { ZipEntryInfo, ZipSkippedEntry } from './batch-zip.js';
import { TREE_SAMPLE_LIMIT } from './batch-zip.js';

export const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);
export const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cpp': 'cpp17',
  '.cc': 'cpp17',
  '.cxx': 'cpp17',
  '.c': 'c11',
};

export type BatchItemFailureStatus = 'skipped' | 'error';

export interface BatchSourceCandidate {
  path: string;
  size: number;
  student: string;
  problemFolder: string;
  /** Resolved problem id; null only for previews that allow unmapped folders. */
  problemId: number | null;
  language: string;
}

export interface BatchPlanFailure {
  student: string;
  sourcePath: string;
  problemId: number | null;
  status: BatchItemFailureStatus;
  errorCode: string;
  errorMessage: string;
}

export interface BatchPlanDuplicate {
  student: string;
  problemFolder: string;
  problemId: number | null;
  sourcePath: string;
}

export interface BatchInvalidStudent {
  student: string;
  reason: string;
  sourcePath: string;
}

export interface BatchPlan {
  candidates: BatchSourceCandidate[];
  failures: BatchPlanFailure[];
  duplicates: BatchPlanDuplicate[];
  /** Normalized central-directory paths seen more than once (first wins). */
  duplicatePaths: string[];
  invalidStudents: BatchInvalidStudent[];
  studentFolders: string[];
  studentSample: string[];
  problemFolders: string[];
  treeSample: string[];
  maxDepth: number;
  totalFiles: number;
  validCount: number;
  skipped: ZipSkippedEntry[];
}

export interface BatchPlanInput {
  files: ZipEntryInfo[];
  directories: ZipEntryInfo[];
  /** Entries skipped by the scanner (unsafe paths / oversized files). */
  skipped?: ZipSkippedEntry[];
  studentLevel: number;
  /** 0 = single-problem batch; > 0 = one problem folder per student folder. */
  problemLevel: number;
  singleProblemId?: number | null;
  problemMap?: Record<string, number>;
  resolveProblem?: (folder: string) => number | null;
  maxSourceBytes: number;
  defaultLanguage: string;
  /**
   * `error` turns an unresolved problem folder into an `UNMAPPED_PROBLEM`
   * failure (import). `allow` keeps the structurally valid source with a null
   * problem id so preview can show `validCount` before mapping.
   */
  unmapped?: 'error' | 'allow';
  treeSampleLimit?: number;
}

function isSourceExtension(extension: string): boolean {
  return SOURCE_EXTENSIONS.has(extension);
}

/**
 * Turns the flat ZIP entry list into student/problem source candidates plus the
 * per-item failures that the import should persist. This is shared by preview
 * and import so both agree on counts and error codes.
 */
export function planBatchSources(input: BatchPlanInput): BatchPlan {
  const multiProblem = input.problemLevel > 0;
  const unmapped = input.unmapped ?? 'error';
  const maxLevel = Math.max(
    input.studentLevel,
    multiProblem ? input.problemLevel : input.studentLevel,
  );
  const files = [...input.files]
    .filter((entry) => !entry.directory)
    .sort((left, right) => left.path.localeCompare(right.path));
  const directories = [...input.directories].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  const studentFolders = new Set<string>();
  const itemStudents = new Set<string>();
  const claimed = new Set<string>();
  const candidates: BatchSourceCandidate[] = [];
  const failures: BatchPlanFailure[] = [];
  const duplicates: BatchPlanDuplicate[] = [];
  const duplicatePaths: string[] = [];
  const seenPaths = new Set<string>();
  const problemFolders = new Set<string>();
  let maxDepth = 0;
  let treeSample: string[] = [];

  const collectStudent = (parts: string[], isDirectory: boolean): string | null => {
    if (isDirectory) {
      if (parts.length >= input.studentLevel) {
        const student = parts[input.studentLevel - 1];
        if (student) studentFolders.add(student);
      }
      return null;
    }
    if (parts.length > input.studentLevel) {
      const student = parts[input.studentLevel - 1];
      if (student) studentFolders.add(student);
      return student ?? null;
    }
    return null;
  };

  for (const directory of directories) {
    const parts = directory.path.split('/').filter(Boolean);
    if (parts.length > 0) maxDepth = Math.max(maxDepth, parts.length);
    collectStudent(parts, true);
  }

  for (const entry of files) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length > 0) maxDepth = Math.max(maxDepth, parts.length);
    collectStudent(parts, false);
  }

  for (const entry of files) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    // Defensive determinism if a caller bypasses scanZipStream: keep the first
    // sorted occurrence of a normalized path and record the rest.
    if (seenPaths.has(entry.path)) {
      duplicatePaths.push(entry.path);
      continue;
    }
    seenPaths.add(entry.path);
    const dot = entry.path.lastIndexOf('.');
    if (dot < 0) continue;
    const extension = entry.path.slice(dot).toLowerCase();
    if (!isSourceExtension(extension)) continue;
    if (parts.length <= maxLevel) continue;
    const student = parts[input.studentLevel - 1];
    if (!student) continue;
    const problemFolder = multiProblem ? (parts[input.problemLevel - 1] ?? '') : '';
    if (multiProblem && problemFolder) problemFolders.add(problemFolder);
    const problemId = multiProblem
      ? (input.resolveProblem?.(problemFolder) ??
        input.problemMap?.[problemFolder] ??
        numericProblem(input, problemFolder))
      : (input.singleProblemId ?? null);
    const claimKey =
      problemId !== null ? `${student}\u0000p:${problemId}` : `${student}\u0000f:${problemFolder}`;
    if (claimed.has(claimKey)) {
      duplicates.push({
        student,
        problemFolder,
        problemId,
        sourcePath: entry.path,
      });
      continue;
    }
    claimed.add(claimKey);
    itemStudents.add(student);

    // Size/emptiness problems are per-source failures regardless of whether a
    // problem mapping exists yet (preview counts must match the future import).
    if (entry.size === 0) {
      failures.push({
        student,
        sourcePath: entry.path,
        problemId,
        status: 'error',
        errorCode: 'EMPTY_SOURCE',
        errorMessage: 'source file is empty',
      });
      continue;
    }
    if (entry.size > input.maxSourceBytes) {
      failures.push({
        student,
        sourcePath: entry.path,
        problemId,
        status: 'error',
        errorCode: 'SOURCE_TOO_LARGE',
        errorMessage: `source is ${entry.size} bytes; limit is ${input.maxSourceBytes} bytes`,
      });
      continue;
    }

    if (problemId === null) {
      if (unmapped === 'error') {
        failures.push({
          student,
          sourcePath: entry.path,
          problemId: null,
          status: 'error',
          errorCode: 'UNMAPPED_PROBLEM',
          errorMessage: `no problem mapping for folder: ${problemFolder || '(empty)'}`,
        });
      } else {
        candidates.push({
          path: entry.path,
          size: entry.size,
          student,
          problemFolder,
          problemId: null,
          language: SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? input.defaultLanguage,
        });
      }
      continue;
    }
    candidates.push({
      path: entry.path,
      size: entry.size,
      student,
      problemFolder,
      problemId,
      language: SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? input.defaultLanguage,
    });
  }

  const sortedStudents = [...studentFolders].sort((left, right) => left.localeCompare(right));
  const invalidStudents: BatchInvalidStudent[] = [];
  for (const student of sortedStudents) {
    if (itemStudents.has(student)) continue;
    const failure: BatchPlanFailure = {
      student,
      sourcePath: student,
      problemId: null,
      status: 'skipped',
      errorCode: 'INVALID_STUDENT_FOLDER',
      errorMessage: 'student folder has no usable source file at the selected level',
    };
    failures.push(failure);
    invalidStudents.push({
      student,
      reason: failure.errorCode,
      sourcePath: failure.sourcePath,
    });
  }

  // A small, deterministic sample of the first levels of the archive tree.
  const limit = input.treeSampleLimit ?? TREE_SAMPLE_LIMIT;
  const seen = new Set<string>();
  for (const entry of [...directories, ...files]) {
    if (seen.size >= limit) break;
    const parts = entry.path.split('/').filter(Boolean);
    const depth = Math.min(parts.length, 3);
    if (depth === 0) continue;
    seen.add(parts.slice(0, depth).join('/'));
  }
  treeSample = [...seen];

  return {
    candidates,
    failures,
    duplicates,
    duplicatePaths,
    invalidStudents,
    studentFolders: sortedStudents,
    studentSample: sortedStudents.slice(0, 100),
    problemFolders: [...problemFolders].sort((left, right) => left.localeCompare(right)),
    treeSample,
    maxDepth,
    totalFiles: files.length,
    validCount: candidates.length,
    skipped: input.skipped ?? [],
  };
}

function numericProblem(input: BatchPlanInput, folder: string): number | null {
  if (!folder) return null;
  const numeric = Number(folder);
  if (!Number.isInteger(numeric)) return null;
  return input.resolveProblem ? input.resolveProblem(folder) : null;
}
