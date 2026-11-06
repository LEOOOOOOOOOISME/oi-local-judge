import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_ADMIN_BODY_BYTES } from '../services/batch-zip.js';
import { ATTACHMENT_BODY_LIMIT } from '../services/attachments.js';

/** Routes whose raw request stream is handed to the handler unchanged. */
const STREAMED_UPLOAD_PATHS = new Set(['/api/admin/batch/uploads']);

const ATTACHMENT_UPLOAD_PATTERN = /^\/api\/admin\/problems\/\d+\/attachments$/;

/** Content types accepted by the attachment upload route (besides octet/zip). */
const ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
  'application/x-zip-compressed',
];

export function isStreamedBatchUploadUrl(url: string): boolean {
  return STREAMED_UPLOAD_PATHS.has(url.split('?')[0]);
}

export function isAttachmentUploadUrl(url: string): boolean {
  return ATTACHMENT_UPLOAD_PATTERN.test(url.split('?')[0]);
}

/**
 * Content-type parser for raw admin uploads (`application/octet-stream`,
 * `application/zip`, plus the attachment MIME types).
 *
 * `POST /api/admin/batch/uploads` receives the request stream itself so the ZIP
 * is written to disk incrementally instead of being buffered. Attachment
 * uploads are bounded to 50 MiB; every other admin upload keeps the historical
 * buffered behaviour (10 GiB P0 limit) because those routes consume a Buffer.
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

  const limit =
    request.method === 'POST' && isAttachmentUploadUrl(request.url)
      ? ATTACHMENT_BODY_LIMIT
      : MAX_ADMIN_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;

  payload.on('data', (chunk: Buffer | string) => {
    if (settled) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) {
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

function unsupportedMediaTypeError(): Error {
  const error = new Error('Unsupported Media Type') as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 415;
  error.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
  return error;
}

/**
 * Buffers PDF/image attachment bodies. The parser is global per content type,
 * so any non-attachment route still gets Fastify's usual 415 instead of a
 * silently accepted buffer.
 */
function attachmentContentTypeParser(
  request: FastifyRequest,
  payload: IncomingMessage,
  done: (error: Error | null, body?: unknown) => void,
): void {
  if (!isAttachmentUploadUrl(request.url)) {
    done(unsupportedMediaTypeError());
    return;
  }
  adminBodyContentTypeParser(request, payload, done);
}

export function registerAdminBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    ['application/octet-stream', 'application/zip'],
    { bodyLimit: MAX_ADMIN_BODY_BYTES },
    adminBodyContentTypeParser,
  );
  for (const contentType of ATTACHMENT_CONTENT_TYPES) {
    app.addContentTypeParser(
      contentType,
      { bodyLimit: ATTACHMENT_BODY_LIMIT },
      attachmentContentTypeParser,
    );
  }
  // Unknown content types (e.g. a browser-declared `text/html`) are accepted
  // only for attachment uploads; the route derives the stored MIME type from
  // the filename extension, so a misleading declaration cannot change how the
  // file is later served. Every other route keeps Fastify's 415 behaviour.
  app.addContentTypeParser(
    '*',
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    attachmentContentTypeParser,
  );
}
