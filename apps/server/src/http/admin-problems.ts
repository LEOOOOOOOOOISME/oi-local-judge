import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { ensureChecker } from '../judge/checker-cache.js';
import { ensureCompiledProgram } from '../judge/compile-cache.js';
import { runValidator } from '../judge/validator.js';
import {
  ASSET_KINDS,
  deleteAsset,
  getAsset,
  listAssets,
  upsertAsset,
  type AssetKind,
} from '../storage/repos/assets.js';
import {
  createProblem,
  getProblem,
  listAllTestcases,
  replaceTestcases,
  updateProblem,
  updateTestcasePoints,
} from '../storage/repos/problems.js';

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c', '.py', '.exe', '.txt']);

function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

function safeRelativePath(name: string): string | null {
  const normalized = normalize(name).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  if (normalized.split('/').some((part) => part === '' || part === '.')) return null;
  return normalized;
}

export interface AdminProblemRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
}

export function registerAdminProblemRoutes(
  app: FastifyInstance,
  options: AdminProblemRouteOptions,
): void {
  const guard = options.adminGuard;

  app.post<{
    Body: {
      title?: string;
      type?: string;
      timeMs?: number;
      memoryMb?: number;
      difficulty?: number;
      tags?: string[];
      ioMode?: 'stdio' | 'file';
      inputFile?: string;
      outputFile?: string;
      statement?: string;
    };
  }>('/api/admin/problems', { preHandler: guard }, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.title || !Number.isFinite(body.timeMs) || !Number.isFinite(body.memoryMb)) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'title, timeMs and memoryMb are required' },
      });
    }
    const id = createProblem(options.db, {
      title: body.title,
      type: body.type ?? 'standard',
      difficulty: body.difficulty ?? null,
      tags: body.tags ?? [],
      timeMs: Number(body.timeMs),
      memoryMb: Number(body.memoryMb),
      ioMode: body.ioMode === 'file' ? 'file' : 'stdio',
      inputFile: body.inputFile ?? null,
      outputFile: body.outputFile ?? null,
      statementHtml: body.statement ?? '',
      testcases: [],
    });
    return reply.code(201).send({ ok: true, data: { id } });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/assets',
    { preHandler: guard },
    async (request) => ({
      ok: true,
      data: listAssets(options.db, Number(request.params.id)),
    }),
  );

  app.put<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>('/api/admin/problems/:id', { preHandler: guard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    if (!getProblem(options.db, problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const body = request.body ?? {};
    const updated = updateProblem(options.db, problemId, {
      title: typeof body.title === 'string' ? body.title : undefined,
      type: typeof body.type === 'string' ? body.type : undefined,
      difficulty: typeof body.difficulty === 'number' ? body.difficulty : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      timeMs: typeof body.timeMs === 'number' ? body.timeMs : undefined,
      memoryMb: typeof body.memoryMb === 'number' ? body.memoryMb : undefined,
      ioMode: body.ioMode === 'file' ? 'file' : body.ioMode === 'stdio' ? 'stdio' : undefined,
      inputFile: typeof body.inputFile === 'string' ? body.inputFile : undefined,
      outputFile: typeof body.outputFile === 'string' ? body.outputFile : undefined,
      statementHtml: typeof body.statementHtml === 'string' ? body.statementHtml : undefined,
      visibility: typeof body.visibility === 'string' ? body.visibility : undefined,
      checkerMode:
        body.checkerMode === 'builtin' || body.checkerMode === 'testlib' || body.checkerMode === 'lemon'
          ? body.checkerMode
          : undefined,
      compareMode: typeof body.compareMode === 'string' ? body.compareMode : undefined,
    });
    if (!updated) {
      return reply.code(400).send({ ok: false, error: { code: 'NO_FIELDS' } });
    }
    return { ok: true, data: { id: problemId } };
  });

  app.get<{ Params: { id: string; kind: string } }>(
    '/api/admin/problems/:id/assets/:kind/source',
    { preHandler: guard },
    async (request, reply) => {
      const kind = request.params.kind;
      if (!isAssetKind(kind)) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_KIND' } });
      }
      const asset = getAsset(options.db, Number(request.params.id), kind);
      if (!asset) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      try {
        const source = readFileSync(join(options.config.dataDir, asset.path), 'utf8');
        return { ok: true, data: { ...asset, source } };
      } catch {
        return reply.code(409).send({
          ok: false,
          error: { code: 'BINARY_OR_MISSING', message: 'source is binary or missing' },
        });
      }
    },
  );

  app.post<{
    Params: { id: string; kind: string };
    Querystring: { name?: string; mode?: string };
  }>(
    '/api/admin/problems/:id/assets/:kind',
    { preHandler: guard, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const kind = request.params.kind;
      if (!isAssetKind(kind)) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_KIND' } });
      }
      if (!getProblem(options.db, problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_FOUND' } });
      }
      const name = basename(request.query.name ?? '');
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (!name || !ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_FILE', message: `unsupported file name: ${name}` },
        });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }

      const relativeDir = `problems/${problemId}/src/${kind}`;
      const relativePath = `${relativeDir}/${name}`;
      mkdirSync(join(options.config.dataDir, relativeDir), { recursive: true });
      writeFileSync(join(options.config.dataDir, relativePath), body);

      const asset = upsertAsset(options.db, {
        problemId,
        kind,
        name,
        path: relativePath,
        language: extension === '.cpp' ? 'cpp17' : null,
        sha256: createHash('sha256').update(body).digest('hex'),
        size: body.length,
      });

      if (kind === 'checker') {
        const mode = request.query.mode === 'lemon' ? 'lemon' : 'testlib';
        options.db
          .prepare('UPDATE problems SET checker_path = ?, checker_mode = ? WHERE id = ?')
          .run(relativePath, mode, problemId);
      }
      return reply.code(201).send({ ok: true, data: asset });
    },
  );

  app.post<{ Params: { id: string; kind: string } }>(
    '/api/admin/problems/:id/assets/:kind/compile',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const kind = request.params.kind;
      if (!isAssetKind(kind)) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_KIND' } });
      }
      const asset = getAsset(options.db, problemId, kind);
      if (!asset) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (!asset.language) {
        return { ok: true, data: { compiled: true, message: 'binary asset, nothing to compile' } };
      }
      const sourcePath = join(options.config.dataDir, asset.path);
      if (kind === 'checker') {
        const result = await ensureChecker({
          gxx: options.config.gxx,
          dataDir: options.config.dataDir,
          sourcePath,
          includeDir: join(process.cwd(), 'vendor'),
        });
        return {
          ok: true,
          data: { compiled: result.ok, exe: result.exe, message: result.message },
        };
      }
      const result = await ensureCompiledProgram({
        gxx: options.config.gxx,
        dataDir: options.config.dataDir,
        sourcePath,
        language: asset.language,
      });
      return {
        ok: true,
        data: { compiled: result.ok, exe: result.exe, cached: result.cached, message: result.message },
      };
    },
  );

  app.delete<{ Params: { id: string; kind: string } }>(
    '/api/admin/problems/:id/assets/:kind',
    { preHandler: guard },
    async (request) => {
      const problemId = Number(request.params.id);
      const kind = request.params.kind;
      if (!isAssetKind(kind)) return { ok: false, error: { code: 'BAD_KIND' } };
      deleteAsset(options.db, problemId, kind);
      if (kind === 'checker') {
        options.db
          .prepare("UPDATE problems SET checker_path = NULL, checker_mode = 'builtin' WHERE id = ?")
          .run(problemId);
      }
      return { ok: true, data: null };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/testcases',
    { preHandler: guard },
    async (request) => ({
      ok: true,
      data: listAllTestcases(options.db, Number(request.params.id)),
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/problems/:id/validate',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const validator = getAsset(options.db, problemId, 'validator');
      if (!validator) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NO_VALIDATOR', message: 'upload a validator first' },
        });
      }
      if (!validator.language) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BINARY_VALIDATOR', message: 'validator must be a source file' },
        });
      }
      const compiled = await ensureCompiledProgram({
        gxx: options.config.gxx,
        dataDir: options.config.dataDir,
        sourcePath: join(options.config.dataDir, validator.path),
        language: validator.language,
        includeDir: join(process.cwd(), 'vendor'),
      });
      if (!compiled.ok || !compiled.exe) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATOR_COMPILE_FAILED', message: compiled.message },
        });
      }
      const workdir = join(options.config.dataDir, 'tmp');
      mkdirSync(workdir, { recursive: true });
      const results = [];
      for (const testcase of listAllTestcases(options.db, problemId)) {
        const result = await runValidator({
          validator: compiled.exe,
          input: join(options.config.dataDir, testcase.input_path),
          workdir,
        });
        results.push({ testcaseId: testcase.id, ...result });
      }
      return {
        ok: true,
        data: {
          passed: results.filter((result) => result.ok).length,
          total: results.length,
          results,
        },
      };
    },
  );

  app.put<{
    Params: { id: string };
    Body: { items?: Array<{ id: number; points: number }> };
  }>(
    '/api/admin/problems/:id/testcases',
    { preHandler: guard },
    async (request, reply) => {
      const items = request.body?.items;
      if (!Array.isArray(items) || items.some((item) => !Number.isFinite(item.points))) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST' } });
      }
      updateTestcasePoints(options.db, Number(request.params.id), items);
      return { ok: true, data: null };
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: { points?: string };
  }>(
    '/api/admin/problems/:id/data/import',
    { preHandler: guard, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!getProblem(options.db, problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_FOUND' } });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }

      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(new Uint8Array(body));
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_ZIP', message: (err as Error).message },
        });
      }

      const destRoot = join(options.config.dataDir, 'problems', String(problemId), 'data');
      const inputs = new Map<string, string>();
      const outputs = new Map<string, string>();
      for (const [rawName, content] of Object.entries(files)) {
        if (rawName.endsWith('/')) continue;
        const relative = safeRelativePath(rawName);
        if (!relative) {
          return reply.code(400).send({
            ok: false,
            error: { code: 'UNSAFE_PATH', message: rawName },
          });
        }
        const target = join(destRoot, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, content);
        const stem = relative.replace(/\.[^.]+$/, '');
        const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
        const stored = `problems/${problemId}/data/${relative}`;
        if (extension === '.in') inputs.set(stem, stored);
        if (extension === '.out' || extension === '.ans') outputs.set(stem, stored);
      }

      if (inputs.size === 0) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'NO_INPUTS', message: 'zip must contain at least one .in file' },
        });
      }
      const missing = [...inputs.keys()].filter((stem) => !outputs.has(stem));
      if (missing.length > 0) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'MISSING_OUTPUTS', message: missing.join(', ') },
        });
      }

      const requestedPoints = Number(request.query.points);
      const points = Number.isFinite(requestedPoints) && requestedPoints > 0 ? requestedPoints : 100;
      const order = [...inputs.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      replaceTestcases(
        options.db,
        problemId,
        order.map((stem) => ({
          inputPath: inputs.get(stem)!,
          outputPath: outputs.get(stem)!,
          points,
        })),
      );

      return reply.code(201).send({
        ok: true,
        data: {
          testcases: order.map((stem) => ({ stem, input: inputs.get(stem), output: outputs.get(stem) })),
        },
      });
    },
  );
}
