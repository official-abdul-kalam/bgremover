const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let backend = null;

function startBackend() {
  const isWin = process.platform === 'win32';
  // Prefer packaged binary if exists; fallback to `python app.py`
  const backendCmd = process.env.BG_REMOVER_BIN || (isWin ? 'python' : 'python3');
  const backendArgs = process.env.BG_REMOVER_BIN ? [] : ['app.py'];

  backend = spawn(backendCmd, backendArgs, {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '7860' },
    stdio: 'inherit',
  });

  backend.on('exit', (code) => {
    backend = null;
    if (mainWindow) mainWindow.webContents.send('backend-exit', code);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0b0f17',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const url = 'http://127.0.0.1:7860';
  mainWindow.loadURL(url);
}

app.whenReady().then(() => {
  startBackend();
  // Small delay to allow backend to boot
  setTimeout(createWindow, 1200);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backend) {
    try { backend.kill(); } catch {}
    backend = null;
  }
});