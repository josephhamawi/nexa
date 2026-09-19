import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only capability.
 *
 * No Node, no remote module, no direct filesystem or network access: every
 * channel below is an explicit request the main process validates. Secrets can
 * be written through here but never read back.
 */
const api = {
  // agent
  getState: () => ipcRenderer.invoke('agent:state'),
  getActivity: () => ipcRenderer.invoke('agent:activity'),
  request: (text: string) => ipcRenderer.invoke('agent:request', text),

  // tasks
  getTask: (id: string) => ipcRenderer.invoke('task:get', id),
  pauseTask: (id: string) => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: string) => ipcRenderer.invoke('task:resume', id),
  cancelTask: (id: string) => ipcRenderer.invoke('task:cancel', id),
  runTask: (id: string) => ipcRenderer.invoke('task:run', id),
  approveTask: (id: string, approved: boolean) => ipcRenderer.invoke('task:approve', { id, approved }),

  // watchers
  setWatcherStatus: (id: string, status: 'ACTIVE' | 'PAUSED') =>
    ipcRenderer.invoke('watcher:setStatus', { id, status }),
  removeWatcher: (id: string) => ipcRenderer.invoke('watcher:remove', id),
  checkWatcher: (id: string) => ipcRenderer.invoke('watcher:check', id),

  // browser and evidence
  openBrowser: (profileId?: string) => ipcRenderer.invoke('browser:open', profileId ?? 'default'),
  openEvidence: (path: string) => ipcRenderer.invoke('evidence:open', path),
  openEvidenceFolder: () => ipcRenderer.invoke('evidence:openFolder'),

  // configuration and secrets
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch: unknown) => ipcRenderer.invoke('config:save', patch),
  pickFolder: () => ipcRenderer.invoke('config:pickFolder'),
  getSecrets: () => ipcRenderer.invoke('secrets:get'),
  saveTelegram: (values: { botToken: string; chatId: string }) =>
    ipcRenderer.invoke('secrets:saveTelegram', values),
  saveLlm: (values: { provider: string; apiKey: string; baseUrl?: string }) =>
    ipcRenderer.invoke('secrets:saveLlm', values),
  testNotifications: () => ipcRenderer.invoke('notifications:test'),

  // push
  onState: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown): void => handler(state);
    ipcRenderer.on('agent:state', listener);
    return () => ipcRenderer.removeListener('agent:state', listener);
  },
  onActivity: (handler: (entry: unknown) => void) => {
    const listener = (_event: unknown, entry: unknown): void => handler(entry);
    ipcRenderer.on('agent:activity', listener);
    return () => ipcRenderer.removeListener('agent:activity', listener);
  },
};

contextBridge.exposeInMainWorld('nexa', api);

export type NexaBridge = typeof api;
