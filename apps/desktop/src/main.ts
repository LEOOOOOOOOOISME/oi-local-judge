import { app, BrowserWindow, utilityProcess } from 'electron';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

let win: BrowserWindow | null = null;

function serverEntry(): string {
  return join(__dirname, '../../../apps/server/dist/cli.js');
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

async function startServer(): Promise<number> {
  const child = utilityProcess.fork(serverEntry(), [], {
    stdio: 'inherit',
    env: { ...process.env, OIJ_PORT: '0', OIJ_HOST: '0.0.0.0' },
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

app.whenReady().then(async () => {
  const port = await startServer();
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
