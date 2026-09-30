import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron';
import { join } from 'node:path';
import { MonitorStore } from './store';
import { MonitorService } from './service';
import { commandSchema } from './commands';
import { CodexProvider } from '../providers/codex';
import { ClaudeProvider } from '../providers/claude';

app.setName('Monitor');
if (process.env.MONITOR_DATA_DIR) app.setPath('userData', process.env.MONITOR_DATA_DIR);
let window: BrowserWindow | null = null,
  service: MonitorService | null = null,
  tray: Tray | null = null;
let quitting = false;
const notifications = new Set<Notification>();
const devUrl = process.env.MONITOR_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Unsupported development URL.');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function testNotification() {
  if (!Notification.isSupported()) {
    dialog.showErrorBox(
      'Notifications unavailable',
      'Native notifications are not supported in this runtime.',
    );
    return;
  }
  const notification = new Notification({
    title: 'Monitor is ready',
    body: 'New completions and requests for attention will appear here.',
  });
  notifications.add(notification);
  notification.on('click', () => void showWindow());
  notification.on('close', () => notifications.delete(notification));
  notification.on('failed', (_event, error) => {
    notifications.delete(notification);
    dialog.showErrorBox(
      'Notification could not be shown',
      error || 'Check macOS notification permissions for Monitor.',
    );
  });
  notification.show();
}

async function openSession(id: string) {
  const url = service!.sessionUrl(id);
  const parsed = new URL(url);
  if (!['codex:', 'claude:'].includes(parsed.protocol))
    throw new Error('Unsupported session destination.');
  if (
    parsed.protocol === 'claude:' &&
    !/^claude:\/\/code\/continue\?session=local_[A-Za-z0-9-]{1,64}$/.test(url)
  )
    throw new Error('Unsupported Claude session destination.');
  await shell.openExternal(url);
}
async function showWindow() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1150,
    height: 800,
    minWidth: 650,
    minHeight: 480,
    title: 'Monitor',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f8f6',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => {
    window = null;
  });
  window.once('ready-to-show', () => window?.show());
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(join(__dirname, '../dist/index.html'));
}
function validateSender(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted Monitor caller.');
}
if (gotLock)
  app
    .whenReady()
    .then(async () => {
      service = new MonitorService(
        new MonitorStore(join(app.getPath('userData'), 'monitor.sqlite')),
        [
          new CodexProvider(),
          new ClaudeProvider({ desktopDir: process.env.MONITOR_CLAUDE_DESKTOP_DIR }),
        ],
        (event) => {
          if (!Notification.isSupported()) return;
          const notification = new Notification({ title: event.title, body: event.body });
          notifications.add(notification);
          notification.on('click', () =>
            // Terminal sessions have no app page; show Monitor, which offers the resume command.
            service?.canOpen(event.sessionId)
              ? void openSession(event.sessionId).catch((error) =>
                  dialog.showErrorBox('Could not open session', String(error)),
                )
              : void showWindow(),
          );
          notification.on('close', () => notifications.delete(notification));
          notification.on('failed', () => notifications.delete(notification));
          notification.show();
        },
      );
      ipcMain.handle('monitor:snapshot', (event) => {
        validateSender(event);
        return service!.snapshot();
      });
      ipcMain.handle('monitor:command', (event, raw) => {
        validateSender(event);
        return service!.command(commandSchema.parse(raw));
      });
      ipcMain.handle('monitor:open-session', async (event, id) => {
        validateSender(event);
        if (typeof id !== 'string' || id.length > 256) throw new Error('Invalid session id.');
        await openSession(id);
      });
      ipcMain.handle('monitor:copy-resume', (event, id) => {
        validateSender(event);
        if (typeof id !== 'string' || id.length > 256) throw new Error('Invalid session id.');
        // Built from observed state, never from renderer-supplied text.
        const command = service!.resumeCommand(id);
        clipboard.writeText(command);
        return command;
      });
      ipcMain.handle('monitor:refresh', async (event) => {
        validateSender(event);
        await service!.refresh();
      });
      service.on('snapshot', (snapshot) => {
        if (window && !window.isDestroyed())
          window.webContents.send('monitor:snapshot-changed', snapshot);
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Monitor',
            submenu: [
              { label: 'Show Monitor', click: () => void showWindow() },
              { label: 'Test notification', click: testNotification },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('◉');
      tray.setToolTip('Monitor · AI workstreams');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Monitor', click: () => void showWindow() },
          { label: 'Test notification', click: testNotification },
          { type: 'separator' },
          { label: 'Quit Monitor', click: () => app.quit() },
        ]),
      );
      tray.on('click', () => void showWindow());
      await service.start();
      await showWindow();
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Monitor could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
app.on('second-instance', () => void showWindow());
app.on('activate', () => {
  if (service) void showWindow();
});
app.on('window-all-closed', () => {
  /* The observer remains active until Quit. */
});
app.on('before-quit', () => {
  quitting = true;
  service?.stop();
  service = null;
  tray?.destroy();
  tray = null;
});
