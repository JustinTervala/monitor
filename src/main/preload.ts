import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorBridge, Snapshot } from '../shared/types';

const bridge: MonitorBridge = {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  command: (command) => ipcRenderer.invoke('monitor:command', command),
  openSession: (id) => ipcRenderer.invoke('monitor:open-session', id),
  copyResumeCommand: (id) => ipcRenderer.invoke('monitor:copy-resume', id),
  showInTerminal: (id) => ipcRenderer.invoke('monitor:show-terminal', id),
  resumeInTerminal: (id) => ipcRenderer.invoke('monitor:resume-terminal', id),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('monitor:snapshot-changed', listener);
    return () => ipcRenderer.removeListener('monitor:snapshot-changed', listener);
  },
};
contextBridge.exposeInMainWorld('monitor', bridge);
