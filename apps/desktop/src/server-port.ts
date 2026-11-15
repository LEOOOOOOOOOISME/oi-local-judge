/**
 * Port passed to the embedded server.
 *
 * Packaged builds must be reachable at the documented localhost:8787 address;
 * OIJ_PORT is kept as an explicit operator override. The early development
 * build used '0' (random port), which made the UI URL undiscoverable.
 */
export function serverPortFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OIJ_PORT?.trim();
  return configured && configured.length > 0 ? configured : '8787';
}
