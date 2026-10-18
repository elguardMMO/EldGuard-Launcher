'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d));
contextBridge.exposeInMainWorld('eld', {
  state: () => ipcRenderer.invoke('state'),
  status: () => ipcRenderer.invoke('status'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  play: () => ipcRenderer.invoke('play'),
  setRam: r => ipcRenderer.invoke('set-ram', r),
  link: w => ipcRenderer.invoke('link', w),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  win: a => ipcRenderer.invoke('win', a),
  onDevice: fn => on('device', fn),
  onLog: fn => on('game:log', fn),
  onProgress: fn => on('game:progress', fn),
  onStarted: fn => on('game:started', fn),
  onClosed: fn => on('game:closed', fn)
});
