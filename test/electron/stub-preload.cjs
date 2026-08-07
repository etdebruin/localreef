// Stand-in for the real preload so the renderer can be exercised without a
// gateway, supervisor, or any apps on disk.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  listApps: async () => [
    { id: 'probe', name: 'Probe', icon: '🧪', type: 'static', status: 'stopped', linked: false },
  ],
  // about:blank keeps the iframe from needing a live origin; the window
  // element around it is what these tests care about.
  launch: async () => ({ ok: true, url: 'about:blank', name: 'Probe', icon: '🧪' }),
  stop: async () => ({ ok: true }),
  reveal: async () => ({ ok: true }),
  generate: async () => ({ ok: false, error: 'stubbed' }),
  link: async () => ({ ok: true, linked: 0, errors: [] }),
  unlink: async () => ({ ok: true }),
  pathForFile: () => null,
  onState: () => () => {},
  onGenerating: () => () => {},
})
