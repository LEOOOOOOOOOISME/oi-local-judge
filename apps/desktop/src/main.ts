import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Tray,
  utilityProcess,
} from 'electron';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  formatInitialAdminNotice,
  redactInitialPassword,
  type InitialAdminNotice,
} from './first-run.js';

/**
 * Embedded 16x16 PNG for the tray icon: a blue rounded square with a white
 * "O". Keeping it inline means the desktop app needs no image asset next to
 * `main.js` and the portable build has nothing extra to copy.
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAX0lEQVR42mNkQAKqya//MxABbs8VZYSxGUnRiM0gJgYKASMu22/NEUHhq6W8Ic4AdI3oAN0gFmIV4jKYCZsibM6FiaEbRHEgDjIDcPkTX/jgjAVC0Um9hDTweYHS7AwAee0w/ptds84AAAAASUVORK5CYII=';

/** Login-item flag: start with the tray (and server) but no visible window. */
const HIDDEN_START_FLAG = '--hidden';

interface DesktopSettings {
  openAtLogin: boolean;
}

const DEFAULT_SETTINGS: DesktopSettings = { openAtLogin: false };

/** Parsed once: the flag only ever comes from the command line. */
const hiddenStart = process.argv.includes(HIDDEN_START_FLAG);

/**
 * Optional userData override. The smoke test (and a portable install on a
 * locked-down machine) needs a data directory that is known to be writable
 * before Electron creates `Local State` and the single-instance lock there.
 */
const USER_DATA_ENV = 'OIJ_DESKTOP_USER_DATA';
const userDataOverride = process.env[USER_DATA_ENV];
if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride));
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProcess: ReturnType<typeof utilityProcess.fork> | null = null;
let serverPort: number | null = null;
/** True only when the embedded server listens on a non-loopback interface. */
let serverLanEnabled = false;
let settings: DesktopSettings = { ...DEFAULT_SETTINGS };
/**
 * Set as soon as quitting starts. BrowserWindow's `close` handler uses it to
 * tell a user close (hide to tray) from a real quit.
 */
let quitting = false;
/** Second-instance/activate arrived before the window existed. */
let pendingShow = false;

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

/** `http://<lan-ip>:<port>/` once the server is up and LAN access is enabled. */
function lanUrl(): string | null {
  if (!serverLanEnabled) return null;
  const lan = lanAddress();
  if (!lan || serverPort === null) return null;
  return `http://${lan}:${serverPort}/`;
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'desktop-settings.json');
}

/**
 * Path of the desktop startup log, or null when no candidate directory is
 * writable. `userData` is preferred; a Low integrity build (or an ACL problem)
 * can make it read-only, in which case `%LOCALAPPDATA%\..\LocalLow` is the
 * documented writable location and still leaves a diagnosable trace.
 */
function chooseStartupLog(): string | null {
  const candidates = [
    join(app.getPath('userData'), 'logs', 'desktop.log'),
    join(homedir(), 'AppData', 'LocalLow', 'OiJudge', 'desktop.log'),
    join(homedir(), '.oijudge', 'desktop.log'),
  ];
  for (const candidate of candidates) {
    try {
      mkdirSync(dirname(candidate), { recursive: true });
      appendFileSync(candidate, '');
      return candidate;
    } catch {
      // Try the next candidate; logging must never block startup.
    }
  }
  return null;
}

let startupLogPath: string | null = null;

/** Writes to the console and the startup log; never throws. */
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (!startupLogPath) return;
  try {
    appendFileSync(startupLogPath, `${line}\n`);
  } catch {
    // A full disk or a revoked permission must not take the app down.
  }
}

/**
 * Verifies that Electron can actually create its `Local State`, cache and
 * single-instance lock in userData. Without this probe a Low integrity build
 * crashes inside `requestSingleInstanceLock()`, which the app used to treat as
 * "another instance is running" and quit silently. Returns an error message
 * when the directory is not writable.
 */
function userDataWriteError(): string | null {
  const directory = app.getPath('userData');
  const probe = join(directory, `.write-probe-${process.pid}`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    return null;
  } catch (error) {
    return `无法写入用户数据目录 ${directory}：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Reads the persisted desktop preferences. A missing, unreadable or malformed
 * file falls back to the defaults so it can never block startup; autostart
 * defaults to off so a fresh install never registers itself silently.
 */
function readSettings(): DesktopSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const openAtLogin = (parsed as { openAtLogin?: unknown }).openAtLogin;
      if (typeof openAtLogin === 'boolean') return { openAtLogin };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('无法读取桌面设置，使用默认值：', error);
    }
  }
  return { ...DEFAULT_SETTINGS };
}

/** Best-effort persistence; a failed write only loses the preference. */
function saveSettings(next: DesktopSettings): void {
  settings = next;
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('无法保存桌面设置：', error);
  }
}

/**
 * Mirrors the stored preference into the OS login item. Packaged OiJudge.exe
 * understands `--hidden` directly; an unpackaged Electron also needs the main
 * script in front of the flag.
 */
function applyLoginItemSettings(openAtLogin: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      args: app.isPackaged
        ? [HIDDEN_START_FLAG]
        : [join(__dirname, 'main.js'), HIDDEN_START_FLAG],
    });
  } catch (error) {
    console.error('无法更新开机自启设置：', error);
  }
}

interface ServerReady {
  port: number;
  host: string;
  initialAdmin?: InitialAdminNotice;
}

/** Starts the local judge server and resolves with its port and boot info. */
async function startServer(root: string): Promise<ServerReady> {
  // The server resolves data, web assets and native helpers relative to its
  // working directory, so pin it to the application root for both layouts.
  const dataDir = join(app.getPath('userData'), 'runtime');
  // Loopback by default. LAN sharing is explicit: OIJ_LAN=1 or OIJ_HOST=0.0.0.0
  // (or a specific interface address) from the launcher/installer.
  const lanRequested = process.env.OIJ_LAN === '1';
  const host = process.env.OIJ_HOST ?? (lanRequested ? '0.0.0.0' : '127.0.0.1');
  const child = utilityProcess.fork(serverEntry(root), [], {
    // `pipe` instead of `inherit`: a packaged GUI app has no reliable inherited
    // stdout, and a blocked inherited handle used to make the child hang
    // before it could report the port. Capturing the output also makes server
    // failures visible in desktop.log and in the error dialog.
    stdio: 'pipe',
    cwd: root,
    env: {
      ...process.env,
      OIJ_PORT: '0',
      OIJ_HOST: host,
      OIJ_DATA_DIR: dataDir,
      OIJ_RUNNER: join(root, 'native/runner/out/ojrunner.exe'),
      OIJ_INTERACT_RUNNER: join(root, 'native/interact/out/ojinteract.exe'),
    },
  });
  serverProcess = child;

  const output: string[] = [];
  const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    const text = chunk.toString();
    output.push(text);
    while (output.length > 200) output.shift();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) log(`[server:${stream}] ${redactInitialPassword(line.trim())}`);
    }
  };
  const tail = (): string =>
    redactInitialPassword(output.join('').trim()).slice(-4000);
  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  child.on('spawn', () => log(`server process spawned pid=${child.pid ?? 'unknown'}`));
  child.on('error', (type: string, location: string, report: string) => {
    log(`server process error type=${type} location=${location}\n${report}`);
  });

  // First launch may be slowed down by antivirus scanning the packaged files;
  // 60 s is deliberately generous, and the failure path reports child output.
  const timeoutMs = Number(process.env.OIJ_SERVER_START_TIMEOUT_MS ?? 60_000);
  return await new Promise<ServerReady>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server start timeout after ${timeoutMs}ms\n${tail()}`)),
      timeoutMs,
    );
    child.on(
      'message',
      (msg: {
        type?: string;
        port?: number;
        host?: string;
        initialAdmin?: InitialAdminNotice;
      }) => {
        if (msg?.type === 'ready' && typeof msg.port === 'number') {
          clearTimeout(timer);
          resolveReady({
            port: msg.port,
            host: typeof msg.host === 'string' ? msg.host : '127.0.0.1',
            ...(msg.initialAdmin ? { initialAdmin: msg.initialAdmin } : {}),
          });
        }
      },
    );
    child.on('exit', (code) => {
      if (serverProcess === child) serverProcess = null;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}\n${tail()}`));
    });
  });
}

/** Stops the utility process during quit; never blocks the app from exiting. */
function stopServer(): void {
  const child = serverProcess;
  serverProcess = null;
  if (!child) return;
  try {
    child.kill();
  } catch (error) {
    console.error('无法停止本地服务：', error);
  }
}

/** Rebuilds the tray menu from the current port, LAN address and settings. */
function buildTrayMenu(): void {
  if (!tray) return;
  const url = lanUrl();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      {
        label: url ? `复制局域网地址（${url}）` : '复制局域网地址',
        enabled: url !== null,
        click: () => {
          const current = lanUrl();
          if (!current) {
            void dialog.showMessageBox({
              type: 'warning',
              title: 'OiJudge',
              message: '未检测到局域网地址',
              detail: '请确认本机已连接局域网后再试。',
            });
            return;
          }
          clipboard.writeText(current);
        },
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: settings.openAtLogin,
        click: (item) => {
          saveSettings({ ...settings, openAtLogin: item.checked });
          applyLoginItemSettings(settings.openAtLogin);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** Creates the tray icon; failure falls back to a normal window-only app. */
function createTray(): void {
  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (icon.isEmpty()) console.warn('内嵌托盘图标无效，将使用空图标。');
    tray = new Tray(icon);
    tray.setToolTip('OiJudge — 本地判题服务');
    tray.on('double-click', () => showMainWindow());
    buildTrayMenu();
  } catch (error) {
    tray = null;
    console.error('无法创建托盘图标：', error);
  }
}

/** Shows and focuses the main window; safe to call before it exists. */
function showMainWindow(): void {
  if (quitting) return;
  const current = win;
  if (!current || current.isDestroyed()) {
    pendingShow = true;
    return;
  }
  pendingShow = false;
  if (current.isMinimized()) current.restore();
  current.show();
  current.focus();
}

async function createWindow(port: number): Promise<BrowserWindow> {
  const created = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'OiJudge',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  created.on('close', (event) => {
    // Plain window close hides the app to the tray instead of ending the
    // background server. A real quit sets `quitting` first; without a tray
    // there would be no way back, so allow the close then.
    if (quitting || !tray) return;
    event.preventDefault();
    created.hide();
  });
  created.on('closed', () => {
    if (win === created) win = null;
  });
  await created.loadURL(`http://127.0.0.1:${port}/`);
  return created;
}

/**
 * Shows the one-time bootstrap administrator password. The password is only
 * available in this process and only on the launch that generated it; it is
 * never written to disk. A "copy password" button avoids transcription errors.
 */
function showInitialAdminNotice(notice: InitialAdminNotice): void {
  const canCopy = notice.reason === 'created' && Boolean(notice.password);
  const buttons = canCopy ? ['复制密码', '知道了'] : ['知道了'];
  const options = {
    type: 'info' as const,
    title: 'OiJudge 管理员账号',
    message: canCopy ? '已生成管理员账号' : '管理员密码需要修改',
    detail: formatInitialAdminNotice(notice),
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true,
  };
  const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  void shown
    .then((result) => {
      if (canCopy && result.response === 0 && notice.password) {
        clipboard.writeText(notice.password);
      }
    })
    .catch((error) => log(`initial admin dialog failed: ${String(error)}`));
}

async function bootstrap(): Promise<void> {
  const root = appRoot();
  process.chdir(root);
  log(`bootstrap root=${root} userData=${app.getPath('userData')}`);

  settings = readSettings();
  // Re-apply on every launch so an install path change (or a stale registry
  // entry) matches the stored preference. Default false never self-starts.
  applyLoginItemSettings(settings.openAtLogin);

  const ready = await startServer(root);
  serverPort = ready.port;
  serverLanEnabled = ready.host !== '127.0.0.1' && ready.host !== 'localhost';
  log(`server ready on port ${ready.port} host=${ready.host}`);
  if (serverLanEnabled) {
    const lan = lanAddress();
    if (lan) log(`LAN: http://${lan}:${ready.port}/`);
  } else {
    log('LAN disabled (loopback only)');
  }

  createTray();
  log(tray ? 'tray ready' : 'tray unavailable; running window-only');
  win = await createWindow(ready.port);
  log('main window loaded');
  // `--hidden` (login item) keeps the window on the tray only; a second
  // instance or a failed tray creation still brings it up.
  if (!hiddenStart || pendingShow || !tray) showMainWindow();
  if (ready.initialAdmin) showInitialAdminNotice(ready.initialAdmin);
  log('startup complete');
}

startupLogPath = chooseStartupLog();
log(
  `starting OiJudge packaged=${app.isPackaged} electron=${process.versions.electron} ` +
    `exec=${process.execPath} userData=${app.getPath('userData')} log=${startupLogPath ?? 'unavailable'}`,
);

// Electron's single-instance lock lives inside userData. A Low integrity build
// cannot create it, and `requestSingleInstanceLock()` then returns false exactly
// like a real second instance. Probe writability first so a permission problem
// is reported instead of silently quitting (the previous P0 symptom).
const dataError = userDataWriteError();
if (dataError) {
  log(`startup aborted: ${dataError}`);
  dialog.showErrorBox(
    'OiJudge 启动失败',
    `${dataError}\n\n` +
      '这通常表示程序或用户数据目录的权限异常（例如以低完整性级别运行）。\n' +
      `日志：${startupLogPath ?? '无法写入日志'}`,
  );
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  // With a writable userData directory a false result means another instance
  // already owns the lock; that instance receives `second-instance` and shows
  // its window.
  log('single-instance lock is held by another instance; exiting');
  app.quit();
} else {
  log('single-instance lock acquired');

  app.on('second-instance', () => {
    log('second-instance received');
    showMainWindow();
  });
  app.on('activate', () => showMainWindow());

  app.on('before-quit', () => {
    // Must run before windows close so their `close` handlers let the quit
    // through, and so the utility process is not left behind.
    log('quitting');
    quitting = true;
    stopServer();
  });

  app.on('window-all-closed', () => {
    // The tray keeps the local judge serving in the background. Only quit when
    // there is no tray to restore from.
    if (!tray) app.quit();
  });

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      log(`startup failed: ${message}`);
      dialog.showErrorBox('OiJudge 启动失败', message);
      quitting = true;
      app.quit();
    });
}
