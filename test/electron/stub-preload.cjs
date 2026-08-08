// Stand-in for the real preload so the renderer can be exercised without a
// gateway, supervisor, or any apps on disk.
const { contextBridge } = require('electron')

// Preload runs in the isolated world, so it cannot set a main-world global for
// the test to read. Keep it here and hand it back through the bridge instead.
let savedSettings = null

// Mirrors src/core/backgrounds.js closely enough to exercise both kinds.
const BACKGROUNDS = [
  {
    id: 'tranquil-reef',
    name: 'Tranquil Reef',
    kind: 'image',
    file: 'tranquil-reef.webp',
    scrim: { top: 0.66, bottom: 0.55, vignette: 0.36 },
  },
  {
    id: 'deep',
    name: 'Deep',
    kind: 'gradient',
    css: 'linear-gradient(to bottom, oklch(0.24 0.05 240), oklch(0.16 0.035 250))',
    scrim: { top: 0.22, bottom: 0.2, vignette: 0.16 },
  },
  {
    id: 'shallows',
    name: 'Shallows',
    kind: 'gradient',
    css: 'linear-gradient(to bottom, oklch(0.4 0.07 210), oklch(0.24 0.05 225))',
    scrim: { top: 0.4, bottom: 0.36, vignette: 0.28 },
  },
  {
    id: 'dusk',
    name: 'Dusk',
    kind: 'gradient',
    css: 'linear-gradient(to bottom, oklch(0.26 0.06 285), oklch(0.17 0.04 275))',
    scrim: { top: 0.26, bottom: 0.24, vignette: 0.2 },
  },
]

contextBridge.exposeInMainWorld('reef', {
  // Two apps so the tile modes are both exercised: one declaring an emoji,
  // one declaring nothing and falling back to a generated tile.
  listApps: async () => [
    {
      id: 'probe',
      name: 'Probe',
      icon: '🧪',
      tile: { kind: 'emoji', image: null, glyph: '🧪', initials: null, hue: null },
      type: 'static',
      status: 'stopped',
      linked: false,
    },
    {
      id: 'feed-reader',
      name: 'Feed Reader',
      icon: null,
      tile: { kind: 'generated', image: null, glyph: null, initials: 'FR', hue: 212 },
      type: 'static',
      status: 'stopped',
      linked: false,
    },
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
    background: BACKGROUNDS[0],
    backgrounds: BACKGROUNDS,
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
