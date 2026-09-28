import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorBridge, Snapshot } from '../shared/types';

const bridge: MonitorBridge = {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  command: (command) => ipcRenderer.invoke('monitor:command', command),
  openSession: (id) => ipcRenderer.invoke('monitor:open-session', id),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('monitor:snapshot-changed', listener);
    return () => ipcRenderer.removeListener('monitor:snapshot-changed', listener);
  },
};
contextBridge.exposeInMainWorld('monitor', bridge);
