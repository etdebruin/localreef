// Stand-in for the real preload so the renderer can be exercised without a
// gateway, supervisor, or any apps on disk.
const { contextBridge } = require('electron')

// Preload runs in the isolated world, so it cannot set a main-world global for
// the test to read. Keep it here and hand it back through the bridge instead.
let savedSettings = null
let hasApiKey = true

// Scenario knobs arrive as query params on the page URL, because module state
// here resets on every reload — a harness that wants a different starting
// state loads the page again with different params.
//   owner:   '' means "no name saved yet"; absent means the default name.
//   session: JSON for getSession, so a harness can hand the renderer a
//            previous desktop to restore.
const params = new URLSearchParams(location.search)
let ownerName = params.has('owner') ? params.get('owner') || null : 'Etienne'
const session = params.has('session')
  ? JSON.parse(params.get('session'))
  : { main: null, windows: [] }
let savedSession = null

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

// Three apps, one per provenance the edit affordance cares about: a linked
// project (someone's real checkout — never editable), a bundled sample
// (editable by adoption), and a ⌘K-built app (editable outright). Mutable so
// a harness can grow it the way a real ⌘K build grows the registry.
const apps = [
  {
    id: 'probe',
    name: 'Probe',
    icon: '🧪',
    tile: { kind: 'emoji', image: null, glyph: '🧪', initials: null, hue: null },
    type: 'static',
    status: 'stopped',
    linked: true,
    generated: false,
    bundled: false,
  },
  {
    id: 'feed-reader',
    name: 'Feed Reader',
    icon: null,
    tile: { kind: 'generated', image: null, glyph: null, initials: 'FR', hue: 212 },
    type: 'static',
    status: 'stopped',
    linked: false,
    generated: false,
    bundled: true,
  },
  {
    id: 'doodle',
    name: 'Doodle',
    icon: null,
    tile: { kind: 'generated', image: null, glyph: null, initials: 'D', hue: 96 },
    type: 'static',
    status: 'stopped',
    linked: false,
    generated: true,
    bundled: false,
  },
]

// The renderer's subscriptions, so a harness can fire lifecycle events at it
// the way main does.
const listeners = { generating: [], generated: [], changed: [] }
let generateCalls = []

contextBridge.exposeInMainWorld('reef', {
  listApps: async () => apps,
  // about:blank keeps the iframe from needing a live origin; the window
  // element around it is what these tests care about.
  launch: async () => ({ ok: true, url: 'about:blank', name: 'Probe', icon: '🧪' }),
  stop: async () => ({ ok: true }),
  reveal: async () => ({ ok: true }),
  // Mirrors main's routed contract: an open or a reply settles the invoke
  // outright; a build resolves as soon as it has an id and the outcome
  // arrives later on the generated channel. Routing is keyed on the prompt's
  // shape so a harness can exercise each path main's classifier can take.
  generate: async (prompt) => {
    generateCalls.push(prompt)
    if (prompt.startsWith('open ')) return { ok: true, action: 'open', id: prompt.slice(5) }
    if (prompt.endsWith('?')) {
      return {
        ok: true,
        action: 'reply',
        reply: 'Reading your mail would need API access you supply — describe an app to build instead.',
      }
    }
    return { ok: true, action: 'build', pending: true, id: 'tide-clock' }
  },
  __generateCalls: () => generateCalls,
  __emitGenerating: (payload) => {
    for (const cb of listeners.generating) cb(payload)
  },
  // ok means main refreshed the registry before announcing — model that by
  // landing the app record first.
  __emitGenerated: (payload) => {
    if (payload.ok && !apps.some((a) => a.id === payload.id)) {
      apps.push({
        id: payload.id,
        name: 'Tide Clock',
        icon: null,
        tile: { kind: 'generated', image: null, glyph: null, initials: 'TC', hue: 200 },
        type: 'static',
        status: 'stopped',
        linked: false,
        generated: true,
      })
    }
    for (const cb of listeners.generated) cb(payload)
  },
  fix: async () => ({ ok: false, error: 'stubbed' }),
  edit: async ({ id } = {}) => ({ ok: true, id, files: ['index.html'], reply: 'Done.' }),
  link: async () => ({ ok: true, linked: 0, errors: [] }),
  unlink: async () => ({ ok: true }),
  pathForFile: () => null,

  getSettings: async () => ({
    background: BACKGROUNDS[0],
    backgrounds: BACKGROUNDS,
    appsFolder: '/tmp/projects',
    ownerName,
    // The real bridge never returns the key itself, only whether one exists.
    anthropicApiKey: null,
    hasApiKey,
    apiKeyFromEnvironment: false,
  }),
  // Record what the renderer sent so the test can assert on the payload.
  updateSettings: async (patch) => {
    savedSettings = patch
    // Mirrors main: saving a key means there is now a key.
    if (patch && patch.anthropicApiKey) hasApiKey = true
    if (patch && 'ownerName' in patch) ownerName = patch.ownerName || null
    return { ok: true, apps: [] }
  },

  getSession: async () => session,
  saveSession: async (windows) => {
    savedSession = windows
    return { ok: true }
  },
  __savedSession: () => savedSession,
  __setHasApiKey: (value) => {
    hasApiKey = value
  },
  chooseFolder: async () => ({ ok: false }),
  __savedSettings: () => savedSettings,

  onState: () => () => {},
  onGenerating: (cb) => {
    listeners.generating.push(cb)
    return () => {}
  },
  onGenerated: (cb) => {
    listeners.generated.push(cb)
    return () => {}
  },
  onFixing: () => () => {},
  onEditing: () => () => {},
  onChanged: (cb) => {
    listeners.changed.push(cb)
    return () => {}
  },
  // Fire the files-changed event the way main does after a watcher hit or a
  // server-app edit restart, so a harness can assert the frame reloads.
  __emitChanged: (payload) => {
    for (const cb of listeners.changed) cb(payload)
  },
})
