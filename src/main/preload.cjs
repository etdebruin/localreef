// CommonJS on purpose: preload scripts run before the ESM loader is available
// in a sandboxed renderer, so a .js file under "type": "module" would fail.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

contextBridge.exposeInMainWorld('reef', {
  listApps: () => ipcRenderer.invoke('apps:list'),
  launch: (id) => ipcRenderer.invoke('apps:launch', id),
  stop: (id) => ipcRenderer.invoke('apps:stop', id),
  reveal: (id) => ipcRenderer.invoke('apps:reveal', id),
  generate: (prompt) => ipcRenderer.invoke('apps:generate', prompt),
  fix: (id) => ipcRenderer.invoke('apps:fix', id),
  edit: (payload) => ipcRenderer.invoke('apps:edit', payload),
  link: (paths) => ipcRenderer.invoke('apps:link', paths),
  unlink: (dir) => ipcRenderer.invoke('apps:unlink', dir),

  getSession: () => ipcRenderer.invoke('session:get'),
  saveSession: (windows) => ipcRenderer.invoke('session:save', windows),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),

  // Electron removed File.path; this is the supported way to recover the real
  // path of a dropped folder.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },

  onState: (callback) => subscribe('apps:state', callback),
  onGenerating: (callback) => subscribe('apps:generating', callback),
  onGenerated: (callback) => subscribe('apps:generated', callback),
  onFixing: (callback) => subscribe('apps:fixing', callback),
  onEditing: (callback) => subscribe('apps:editing', callback),
  onChanged: (callback) => subscribe('apps:changed', callback),
})
