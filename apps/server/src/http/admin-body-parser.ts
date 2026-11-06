import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_ADMIN_BODY_BYTES } from '../services/batch-zip.js';

/** Routes whose raw request stream is handed to the handler unchanged. */
const STREAMED_UPLOAD_PATHS = new Set(['/api/admin/batch/uploads']);

export function isStreamedBatchUploadUrl(url: string): boolean {
  return STREAMED_UPLOAD_PATHS.has(url.split('?')[0]);
}

/**
 * Content-type parser for raw admin uploads (`application/octet-stream` and
 * `application/zip`).
 *
 * `POST /api/admin/batch/uploads` receives the request stream itself so the ZIP
 * is written to disk incrementally instead of being buffered. Every other
 * admin upload keeps the historical buffered behaviour (bounded to 10 GiB, the
 * P0 body limit) because those routes still consume a Buffer.
 */
export function adminBodyContentTypeParser(
  request: FastifyRequest,
  payload: IncomingMessage,
  done: (error: Error | null, body?: unknown) => void,
): void {
  if (request.method === 'POST' && isStreamedBatchUploadUrl(request.url)) {
    done(null, payload);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;

  payload.on('data', (chunk: Buffer | string) => {
    if (settled) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_ADMIN_BODY_BYTES) {
      settled = true;
      const error = new Error('Request body is too large') as Error & {
        statusCode?: number;
        code?: string;
      };
      error.statusCode = 413;
      error.code = 'FST_ERR_CTP_BODY_TOO_LARGE';
      done(error);
      return;
    }
    chunks.push(buffer);
  });
  payload.on('end', () => {
    if (settled) return;
    settled = true;
    done(null, Buffer.concat(chunks));
  });
  payload.on('error', (error) => {
    if (settled) return;
    settled = true;
    done(error);
  });
}

export function registerAdminBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    ['application/octet-stream', 'application/zip'],
    { bodyLimit: MAX_ADMIN_BODY_BYTES },
    adminBodyContentTypeParser,
  );
}
