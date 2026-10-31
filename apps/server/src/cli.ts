import { buildApp } from './app.js';

const app = await buildApp({ logger: true });
const port = Number(process.env.OIJ_PORT ?? 8787);
const host = process.env.OIJ_HOST ?? '0.0.0.0';
await app.listen({ port, host });

const address = app.server.address();
const actualPort = typeof address === 'object' && address ? address.port : port;
app.log.info({ port: actualPort, host }, 'ojserver listening');

const parentPort = (
  process as unknown as {
    parentPort?: { postMessage(value: unknown): void };
  }
).parentPort;
parentPort?.postMessage({ type: 'ready', port: actualPort });
