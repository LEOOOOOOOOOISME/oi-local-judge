import { app, BrowserWindow, dialog, utilityProcess } from 'electron';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

let win: BrowserWindow | null = null;

/**
 * Root directory that contains `apps/`, `native/`, `vendor/` and
 * `node_modules/`.
 *
 * In development this is the repository root (apps/desktop/dist -> ../../..).
 * In a packaged build Electron puts the app at `resources/app`, so every
 * runtime path must be resolved from there instead of relying on the current
 * working directory.
 */
function appRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app') : join(__dirname, '../../..');
}

function serverEntry(root: string): string {
  return join(root, 'apps/server/dist/cli.js');
}

/** First non-internal IPv4 address, or null when the machine has none. */
function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function startServer(root: string): Promise<number> {
  // The server resolves data, web assets and native helpers relative to its
  // working directory, so pin it to the application root for both layouts.
  const dataDir = join(app.getPath('userData'), 'runtime');
  const child = utilityProcess.fork(serverEntry(root), [], {
    stdio: 'inherit',
    cwd: root,
    env: {
      ...process.env,
      OIJ_PORT: '0',
      OIJ_HOST: '0.0.0.0',
      OIJ_DATA_DIR: dataDir,
      OIJ_RUNNER: join(root, 'native/runner/out/ojrunner.exe'),
      OIJ_INTERACT_RUNNER: join(root, 'native/interact/out/ojinteract.exe'),
    },
  });
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 15000);
    child.on('message', (msg: { type?: string; port?: number }) => {
      if (msg?.type === 'ready' && typeof msg.port === 'number') {
        clearTimeout(timer);
        resolve(msg.port);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}`));
    });
  });
}

app
  .whenReady()
  .then(async () => {
    const root = appRoot();
    process.chdir(root);
    const port = await startServer(root);
    const lan = lanAddress();
    if (lan) console.log(`LAN: http://${lan}:${port}/`);
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      title: 'OiJudge',
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadURL(`http://127.0.0.1:${port}/`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    dialog.showErrorBox('OiJudge 启动失败', message);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
