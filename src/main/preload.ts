import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer gets a narrow, explicit API, no Node access, no remote module.
 * Every channel here is request/response except the two push subscriptions.
 */
const api = {
  getState: () => ipcRenderer.invoke('monitor:getState'),
  getEvents: () => ipcRenderer.invoke('monitor:getEvents'),
  start: () => ipcRenderer.invoke('monitor:start'),
  pause: () => ipcRenderer.invoke('monitor:pause'),
  resume: () => ipcRenderer.invoke('monitor:resume'),
  stop: () => ipcRenderer.invoke('monitor:stop'),
  checkNow: () => ipcRenderer.invoke('monitor:checkNow'),
  openBrowser: () => ipcRenderer.invoke('monitor:openBrowser'),
  openLogin: () => ipcRenderer.invoke('monitor:openLogin'),
  openScreenshot: (path: string) => ipcRenderer.invoke('monitor:openScreenshot', path),
  openScreenshotFolder: () => ipcRenderer.invoke('monitor:openScreenshotFolder'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  getOptions: () => ipcRenderer.invoke('options:get'),
  refreshOptions: () => ipcRenderer.invoke('options:refresh'),
  getTelegram: () => ipcRenderer.invoke('telegram:get'),
  saveTelegram: (values: { botToken: string; chatId: string }) =>
    ipcRenderer.invoke('telegram:save', values),
  saveConfig: (patch: unknown) => ipcRenderer.invoke('config:save', patch),
  testNotifications: () => ipcRenderer.invoke('notifications:test'),

  onState: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown): void => handler(state);
    ipcRenderer.on('monitor:state', listener);
    return () => ipcRenderer.removeListener('monitor:state', listener);
  },
  onEvent: (handler: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on('monitor:event', listener);
    return () => ipcRenderer.removeListener('monitor:event', listener);
  },
};

contextBridge.exposeInMainWorld('bls', api);

export type BlsBridge = typeof api;
