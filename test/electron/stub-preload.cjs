// Stand-in for the real preload so the renderer can be exercised without a
// gateway, supervisor, or any apps on disk.
const { contextBridge } = require('electron')

// Preload runs in the isolated world, so it cannot set a main-world global for
// the test to read. Keep it here and hand it back through the bridge instead.
let savedSettings = null

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

  getSettings: async () => ({
    appsFolder: '/tmp/projects',
    // The real bridge never returns the key itself, only whether one exists.
    anthropicApiKey: null,
    hasApiKey: true,
    apiKeyFromEnvironment: false,
  }),
  // Record what the renderer sent so the test can assert on the payload.
  updateSettings: async (patch) => {
    savedSettings = patch
    return { ok: true, apps: [] }
  },
  chooseFolder: async () => ({ ok: false }),
  __savedSettings: () => savedSettings,

  onState: () => () => {},
  onGenerating: () => () => {},
})
