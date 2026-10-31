/**
 * Minimal Electron smoke test.
 * Run from a normal PowerShell (not the DSH sandbox):
 *   npm run electron:smoke
 * Then inspect electron-smoke.log.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', 'electron-smoke.log');
function log(message) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

fs.writeFileSync(logPath, '');
log(
  `boot electron=${process.versions.electron} node=${process.versions.node} ` +
    `runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? '<unset>'}`,
);

app.disableHardwareAcceleration();

const timeout = setTimeout(() => {
  log(`timeout isReady=${app.isReady()}`);
  app.exit(2);
}, 20000);

app
  .whenReady()
  .then(async () => {
    log('app ready');
    const win = new BrowserWindow({ width: 800, height: 600, show: true });
    await win.loadURL(
      'data:text/html,<html><head><title>OiJudge Smoke</title></head><body><h1>OiJudge smoke OK</h1></body></html>',
    );
    log(`window loaded title=${win.getTitle()}`);
    setTimeout(() => {
      clearTimeout(timeout);
      log('quitting');
      app.quit();
    }, 3000);
  })
  .catch((err) => {
    clearTimeout(timeout);
    log(`error ${err.stack ?? err}`);
    app.exit(1);
  });
