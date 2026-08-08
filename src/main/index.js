/**
 * Electron main process.
 *
 * Wires the three pieces together: registry (what apps exist), supervisor
 * (which are running), gateway (how the browser reaches them), and hands the
 * renderer a URL per app.
 */

import { app, BrowserWindow, dialog, ipcMain, screen, session, shell, systemPreferences } from 'electron'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import fs from 'node:fs/promises'

import { scanApps, readApp } from '../core/registry.js'
import { createLinkStore } from '../core/links.js'
import { createSettingsStore, resolveApiKey, DEFAULT_GATEWAY_PORT } from '../core/settings.js'
import { createSessionStore } from '../core/session.js'
import { readIconImage, isImageIcon, initialsFor, hueFor } from '../core/icon.js'
import { BACKGROUNDS, resolveBackground } from '../core/backgrounds.js'
import { allowsMedia, framePolicy } from '../core/policy.js'
import { createConsoleCapture } from '../core/console.js'
import { createSupervisor } from './supervisor.js'
import { createGateway } from '../gateway/index.js'
import { AUTH_PARAM, AUTH_HEADER } from '../gateway/auth.js'
import { MODELS, createGenerator, createFixer, createEditor, createClaudeRunner } from './agent.js'
import { createWatcher } from './watcher.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')

// Guarantee *.reef.localhost resolves to loopback rather than trusting the
// system resolver to do the RFC 6761 thing.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

// Pin userData explicitly. Run from source it derives from package.json's
// `name`, run from a bundle it derives from `productName` — so a packaged
// build would keep its settings, links and generated apps in a *different*
// folder from the dev build. Same folder either way.
app.setPath('userData', path.join(app.getPath('appData'), 'localreef'))

// One Reef at a time. Two instances would fight over the pinned gateway port,
// and two desktops writing one session.json was never coherent anyway. A
// second launch hands focus to the first instead — including the packaged
// app and `npm start` side by side, which share userData and were already
// quietly corrupting each other.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else if (app.isReady()) {
    createWindow()
  }
})

const TOKEN = crypto.randomBytes(24).toString('hex')

const NO_KEY = 'No Anthropic API key. Add one in Settings, or set ANTHROPIC_API_KEY and relaunch.'

let links = null
let settings = null
let sessionStore = null
let mainWindow = null
let gateway = null
let apps = new Map()

const supervisor = createSupervisor({
  onChange: (id, state) => {
    mainWindow?.webContents.send('apps:state', { id, ...state })
  },
  // Read at spawn time so a key pasted into Settings reaches the next app
  // started, no relaunch. Apps only see it if their manifest declares `ai`.
  resolveApiKey: async () => resolveApiKey(await settings.read()),
})

// Errors the app frames log, sorted per app, so a fix or edit turn can hand
// the model the actual exception instead of a description of its symptom.
const consoleCapture = createConsoleCapture()

// Folder watching for open static apps: an edit — from the ⌘K chat or the
// user's own editor — reloads the frame. Server apps are never watched; their
// dev servers own reload (Vite HMR rides the gateway's WebSocket relay).
const watcher = createWatcher({
  onChange: (id) => {
    // The files just changed, so errors thrown by the old code are no longer
    // evidence — they would steer the next fix at a bug that may be gone.
    consoleCapture.clear(id)
    mainWindow?.webContents.send('apps:changed', { id })
  },
})

// Edit-chat conversations, per app, in memory only — the durable state is the
// files. History is appended only after a successful turn (a refusal or error
// leaves it untouched so the user can rephrase) and dies with the window.
const editSessions = new Map()
const editBusy = new Set()
// Bumped on teardown so a turn racing a window close can't resurrect the
// session it was started under.
const editEpoch = new Map()

/** How many past messages an edit turn carries. Disk is the real state, so
 * truncating old turns costs continuity, never correctness. */
const EDIT_HISTORY_LIMIT = 24

async function refreshApps() {
  const bundled = await scanApps(path.join(projectRoot, 'apps'))

  // Apps ⌘K built. The flag derives from where the folder lives — not from
  // anything in the folder — so a copied or linked app can't claim it, and a
  // linked folder shadowing the same id loses it in the later-wins merge.
  // `generated` is what gates the edit chat: reef owns these folders, so the
  // agent may edit them freely; everything else is somebody's real checkout.
  const generated = (await scanApps(path.join(app.getPath('userData'), 'apps'))).map((a) => ({
    ...a,
    generated: true,
  }))

  // The user's own projects folder. Discovery here is opt-in — only folders
  // carrying a reef.json — because it is a working directory, not a
  // curated one. See scanApps.
  const { appsFolder } = await settings.read()
  const discovered = appsFolder ? await scanApps(appsFolder, { requireManifest: true }) : []

  // Linked projects live wherever they already are; we read the folder in
  // place rather than copying anything.
  const linkedDirs = await links.list()
  const linked = await Promise.all(linkedDirs.map(readApp))

  // Later entries win on an id collision, so the order is least to most
  // explicit: a bundled sample yields to a generated app, which yields to one
  // found in your projects folder, which yields to a folder you linked by hand.
  const all = [
    ...bundled,
    ...generated,
    ...discovered.map((a) => ({ ...a, discovered: true })),
    ...linked.map((a) => ({ ...a, linked: true })),
  ]
  // Resolve declared icon files once per refresh rather than per render — a
  // linked app's icon lives on disk wherever the project does.
  await Promise.all(
    all.map(async (record) => {
      record.iconImage = await readIconImage(record.dir, record.icon)
    }),
  )

  apps = new Map(all.map((a) => [a.id, a]))
  return [...apps.values()]
}

/**
 * Everything the renderer needs to draw the tile, decided here so the renderer
 * never has to reason about what an icon is.
 *
 * `generated` is the fallback for both "no icon declared" and "declared an
 * image file we could not read" — a broken path should still leave a usable
 * icon rather than a blank square.
 */
function tileFor(record) {
  if (record.iconImage) {
    return { kind: 'image', image: record.iconImage, glyph: null, initials: null, hue: null }
  }

  if (record.icon && !isImageIcon(record.icon)) {
    return { kind: 'emoji', image: null, glyph: record.icon, initials: null, hue: hueFor(record.id) }
  }

  return {
    kind: 'generated',
    image: null,
    glyph: null,
    initials: initialsFor(record.name),
    hue: hueFor(record.id),
  }
}

function urlFor(id, { withToken = false } = {}) {
  const base = `http://${id}.reef.localhost:${gateway.port}/`
  return withToken ? `${base}?${AUTH_PARAM}=${TOKEN}` : base
}

function serialise(record) {
  const state = supervisor.get(record.id)
  return {
    id: record.id,
    dir: record.dir,
    linked: record.linked ?? false,
    discovered: record.discovered ?? false,
    generated: record.generated ?? false,
    name: record.name,
    icon: record.icon,
    tile: tileFor(record),
    type: record.type,
    error: record.error,
    status: record.error ? 'broken' : state.status,
    logs: state.logs,
  }
}

async function createWindow() {
  // Reopening the shell puts it back exactly where it was — size and position
  // both. Position is only reused while it still lands on a live display; a
  // saved x/y from an unplugged monitor would otherwise open the window
  // somewhere no one can see it.
  const saved = (await sessionStore.read()).main
  const visible =
    saved &&
    screen.getAllDisplays().some(({ workArea }) => {
      return (
        saved.x < workArea.x + workArea.width &&
        saved.x + saved.width > workArea.x &&
        saved.y < workArea.y + workArea.height &&
        saved.y + saved.height > workArea.y
      )
    })

  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(visible ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'Local Reef',
    backgroundColor: '#11131a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // One console-message stream carries the whole desktop: the shell's own
  // renderer and every app iframe. Surface problems in the terminal — without
  // this a thrown error in renderer.js is an invisible blank desktop — and
  // sort app-frame errors into the per-app capture, where the next fix or
  // edit turn picks them up as evidence.
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron changed this signature mid-life: older builds pass positional
    // arguments, newer ones a details object (which also names the frame —
    // the only reliable attribution for an app's errors).
    const details = typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const level = details ? details.level : args[1]
    const message = details ? details.message : args[2]
    const line = details ? details.lineNumber : args[3]
    const sourceUrl = details ? details.sourceId : args[4]

    const appId = consoleCapture.record({
      level,
      message,
      line,
      sourceUrl,
      frameUrl: details?.frame?.url,
    })

    if (level === 'error' || level === 'warning' || level >= 2) {
      console.error(`[${appId ?? 'renderer'}] ${message}  (${sourceUrl}:${line})`)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  // Track bounds as they change rather than trying to catch the close: a
  // debounced save is always already on disk when the window goes away, so
  // there is no write racing the teardown.
  let boundsTimer = null
  const saveBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sessionStore.update({ main: mainWindow.getBounds() })
      }
    }, 400)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  await mainWindow.loadFile(path.join(projectRoot, 'src/renderer/index.html'))
  mainWindow.on('closed', () => {
    clearTimeout(boundsTimer)
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  links = createLinkStore(path.join(app.getPath('userData'), 'links.json'))
  settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  sessionStore = createSessionStore(path.join(app.getPath('userData'), 'session.json'))

  // Authenticate framed apps by header rather than cookie. An app iframe is a
  // cross-site context relative to the file:// renderer, so a SameSite=Lax
  // cookie gets stored and then never sent back — the app would load once and
  // 401 on the redirect. Scoped strictly to app origins so the token cannot
  // leak anywhere else.
  // ws:// and wss:// are listed explicitly. A `*` scheme in a Chrome match
  // pattern means http or https and nothing else, so the http-only filter
  // never matched a WebSocket handshake — every app's upgrade reached the
  // gateway with no credential and was destroyed. The clock sample sat on
  // "disconnected — retrying" and Vite HMR would have failed the same way.
  // Guarded by test/electron/iframe-websocket.mjs.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.reef.localhost/*',
        'ws://*.reef.localhost/*',
        'wss://*.reef.localhost/*',
      ],
    },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    },
  )

  // The second gate on device access. The iframe's `allow` attribute only
  // stops Permissions Policy from denying the frame outright; Chromium still
  // raises a permission request, and without a handler Electron answers it
  // for us. Answer it from the manifest instead, so an app reaches the
  // microphone only if it said it would.
  const appIdFor = (url) => {
    try {
      const { hostname } = new URL(url)
      return hostname.endsWith('.reef.localhost') ? hostname.slice(0, -'.reef.localhost'.length) : null
    } catch {
      return null
    }
  }

  const declaredBy = (url) => apps.get(appIdFor(url) ?? '')?.permissions ?? []

  // macOS gates the *bundle*, separately from the page, and the grant is per
  // bundle id — a dev run and Local Reef.app are two different answers as far
  // as the OS is concerned. Ask explicitly rather than hoping Chromium raises
  // the prompt for us. A previous "Don't Allow" is remembered by the system
  // and only System Settings › Privacy can undo it.
  const askMacOS = async (mediaTypes) => {
    if (process.platform !== 'darwin') return true
    for (const type of mediaTypes) {
      const device = type === 'audio' ? 'microphone' : 'camera'
      if (!(await systemPreferences.askForMediaAccess(device))) return false
    }
    return true
  }

  session.defaultSession.setPermissionRequestHandler(
    async (contents, permission, callback, details) => {
      const url = details?.requestingUrl ?? contents?.getURL() ?? ''
      const mediaTypes = details?.mediaTypes ?? []
      if (permission !== 'media' || !allowsMedia(declaredBy(url), mediaTypes)) {
        return callback(false)
      }
      callback(await askMacOS(mediaTypes))
    },
  )

  // The synchronous path: enumerateDevices() labels and permissions.query()
  // consult this one rather than raising a request.
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === 'media' && framePolicy(declaredBy(requestingOrigin ?? '')) !== '',
  )

  gateway = createGateway({ token: TOKEN, lookup: (id) => lookupForGateway(id) })

  // The port is identity, not plumbing: every app's origin — and therefore
  // its localStorage — includes it. `listen(0)` here cost a real user's data,
  // stranding it under the previous launch's origin. Pin the port, persist
  // the pin, and never fall back to another one: a fallback would "work"
  // while silently swapping every app's storage out from under it.
  const stored = await settings.read()
  const gatewayPort = stored.gatewayPort ?? DEFAULT_GATEWAY_PORT
  if (stored.gatewayPort == null) await settings.update({ gatewayPort })

  try {
    await gateway.listen(gatewayPort)
  } catch (err) {
    dialog.showErrorBox(
      'Local Reef could not start',
      `Port ${gatewayPort} is already in use, and apps' saved data lives on it, ` +
        `so Reef will not start on a different one.\n\n` +
        `Quit whatever is holding the port and relaunch.\n\n(${err.message})`,
    )
    app.exit(1)
    return
  }

  await refreshApps()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** The gateway asks for a live view: registry record merged with run state. */
function lookupForGateway(id) {
  const record = apps.get(id)
  if (!record || record.error) return null

  const state = supervisor.get(id)
  return {
    id,
    type: record.type,
    root: record.root,
    status: record.type === 'static' ? 'ready' : state.status,
    port: state.port,
    host: state.host,
  }
}

ipcMain.handle('apps:list', async () => {
  const records = await refreshApps()
  return records.map(serialise)
})

ipcMain.handle('apps:launch', async (_event, id) => {
  const record = apps.get(id)
  if (!record) return { ok: false, error: `No app called "${id}"` }
  if (record.error) return { ok: false, error: record.error }

  const state = await supervisor.ensureStarted(record)
  if (state.status !== 'ready') {
    return { ok: false, error: state.error ?? 'Failed to start', logs: state.logs }
  }

  // Watch record.dir, not record.root: root can be a build output (dist/),
  // and edits land in the source folder.
  if (record.type === 'static') watcher.watch(id, record.dir)

  return {
    ok: true,
    url: urlFor(id, { withToken: true }),
    name: record.name,
    icon: record.icon,
    // Permissions Policy for the frame. Main decides it, not the renderer, so
    // the manifest is the only thing that can widen an app's device access.
    allow: framePolicy(record.permissions),
  }
})

// The single teardown hook: the renderer calls this for every window close
// (static apps included — supervisor.stop is a no-op for them), so anything
// scoped to "this app is open" dies here.
ipcMain.handle('apps:stop', async (_event, id) => {
  watcher.unwatch(id)
  editSessions.delete(id)
  editEpoch.set(id, (editEpoch.get(id) ?? 0) + 1)
  await supervisor.stop(id)
  return { ok: true }
})

ipcMain.handle('apps:link', async (_event, paths) => {
  const results = []
  for (const dir of paths ?? []) results.push(await links.add(dir))

  await refreshApps()
  const failed = results.filter((r) => !r.ok)
  return { ok: failed.length === 0, linked: results.filter((r) => r.ok).length, errors: failed }
})

ipcMain.handle('apps:unlink', async (_event, dir) => {
  await links.remove(dir)
  await refreshApps()
  return { ok: true }
})

// The renderer owns app-window geometry, so it reports the whole arrangement
// (in z-order) whenever it changes; main just keeps the latest on disk. The
// read side hands it back on startup so the desktop reassembles itself.
ipcMain.handle('session:get', async () => sessionStore.read())

ipcMain.handle('session:save', async (_event, windows) => {
  await sessionStore.update({ windows: windows ?? [] })
  return { ok: true }
})

ipcMain.handle('settings:get', async () => {
  const current = await settings.read()
  return {
    ...current,
    // Resolved rather than raw: a stale id from an older release must not
    // leave the canvas blank, and the renderer should not have to know that.
    background: resolveBackground(current.backgroundId),
    backgrounds: BACKGROUNDS,
    // Never ship the key itself back to the renderer — the UI only needs to
    // know whether one is set and where it came from.
    anthropicApiKey: null,
    hasApiKey: Boolean(resolveApiKey(current)),
    apiKeyFromEnvironment: !current.anthropicApiKey && Boolean(process.env.ANTHROPIC_API_KEY),
  }
})

ipcMain.handle('settings:update', async (_event, patch) => {
  await settings.update(patch ?? {})
  const records = await refreshApps()
  return { ok: true, apps: records.map(serialise) }
})

ipcMain.handle('settings:chooseFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your projects folder',
    properties: ['openDirectory', 'createDirectory'],
  })

  if (canceled || !filePaths?.length) return { ok: false }
  return { ok: true, dir: filePaths[0] }
})

ipcMain.handle('apps:reveal', async (_event, id) => {
  const record = apps.get(id)
  if (record) shell.showItemInFolder(record.dir)
  return { ok: true }
})

// Generated apps land in userData, never in the repo's apps/ folder — that one
// holds the samples and anything the user is editing by hand.
//
// The invoke resolves as soon as the build has an id — a generation is minutes
// long and holding the renderer's promise open for all of it would make the
// palette modal. Progress streams over 'apps:generating' and the final result
// lands on 'apps:generated', after the registry already knows the new app, so
// the renderer's listApps on receipt sees it.
ipcMain.handle('apps:generate', async (_event, prompt) => {
  if (!String(prompt ?? '').trim()) return { ok: false, error: 'Describe what to build.' }

  const apiKey = resolveApiKey(await settings.read())
  if (!apiKey) return { ok: false, error: NO_KEY }

  const generatedDir = path.join(app.getPath('userData'), 'apps')
  await fs.mkdir(generatedDir, { recursive: true })

  const generator = createGenerator({
    appsDir: generatedDir,
    runAgent: createClaudeRunner({ apiKey, model: MODELS.generate }),
  })

  const { id, done } = generator.start({
    prompt,
    onProgress: (progress) => mainWindow?.webContents.send('apps:generating', progress),
  })

  done.then(
    async (result) => {
      if (result.ok) await refreshApps()
      mainWindow?.webContents.send('apps:generated', result)
    },
    // generate never rejects today; this keeps a future regression from
    // leaving the renderer with a bubble that never pops.
    (err) => mainWindow?.webContents.send('apps:generated', { ok: false, error: String(err?.message ?? err) }),
  )

  try {
    return { ok: true, pending: true, id: await id }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
})

ipcMain.handle('apps:fix', async (_event, id) => {
  const record = apps.get(id)
  if (!record) return { ok: false, error: `No app called "${id}"` }

  const apiKey = resolveApiKey(await settings.read())
  if (!apiKey) return { ok: false, error: NO_KEY }

  const state = supervisor.get(id)
  const fixer = createFixer({ runAgent: createClaudeRunner({ apiKey, model: MODELS.fix }) })

  const result = await fixer.fix({
    id,
    dir: record.dir,
    name: record.name,
    // A registry error (unreadable manifest) and a runtime crash are both
    // "why this app will not open"; the model gets whichever applies.
    error: record.error ?? state.error ?? 'The app failed to start.',
    logs: state.logs ?? [],
    consoleErrors: consoleCapture.recent(id),
    onProgress: (progress) => mainWindow?.webContents.send('apps:fixing', progress),
  })

  // Drop the old process so the next launch picks up the edited files.
  if (result.ok) {
    await supervisor.stop(id)
    await refreshApps()
  }

  return result
})

// One conversational turn of the edit chat. The provenance gate lives HERE,
// not only in the renderer: the fixer's linked-folder confirm is renderer-only
// and that is acceptable for a repair the user explicitly clicked, but edit
// turns write on every message — main must refuse folders reef does not own.
ipcMain.handle('apps:edit', async (_event, { id, message } = {}) => {
  const record = apps.get(id)
  if (!record) return { ok: false, error: `No app called "${id}"` }
  if (!record.generated) return { ok: false, error: 'Only apps built with ⌘K can be edited here.' }
  if (!String(message ?? '').trim()) return { ok: false, error: 'Say what to change.' }
  if (editBusy.has(id)) return { ok: false, error: 'Still applying the last change.' }

  const apiKey = resolveApiKey(await settings.read())
  if (!apiKey) return { ok: false, error: NO_KEY }

  editBusy.add(id)
  const epoch = editEpoch.get(id) ?? 0
  try {
    const history = editSessions.get(id) ?? []
    const editor = createEditor({ runAgent: createClaudeRunner({ apiKey, model: MODELS.edit }) })

    const result = await editor.edit({
      id,
      dir: record.dir,
      name: record.name,
      message,
      history,
      consoleErrors: consoleCapture.recent(id),
      // Every event carries the id so concurrent edit sessions cannot cross
      // streams — the palette-era 'thinking' event never had one.
      onProgress: (progress) => mainWindow?.webContents.send('apps:editing', { ...progress, id }),
    })

    if (result.ok && (editEpoch.get(id) ?? 0) === epoch) {
      editSessions.set(
        id,
        [
          ...history,
          { role: 'user', content: message },
          { role: 'assistant', content: result.reply },
        ].slice(-EDIT_HISTORY_LIMIT),
      )
      // The turn may have renamed the app or changed its icon.
      await refreshApps()
    }

    // No forced reload here: the watcher sees the writes and the frame
    // reloads through the same path as any other file change.
    return result
  } finally {
    editBusy.delete(id)
  }
})

async function shutdown() {
  watcher.close()
  await supervisor.stopAll()
  await gateway?.close()
}

// On macOS the red dot hides the shell, it does not end the session: gateway
// and supervisor stay up, so clicking the Dock icon reassembles the desktop —
// same window bounds, same apps, same positions — with every server app's
// in-memory state intact. Tearing it all down here was why a reopened window
// used to come back to a dead gateway. Everywhere else, closing the window is
// quitting, and before-quit still shuts everything down.
app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await shutdown()
    app.quit()
  }
})

app.on('before-quit', shutdown)
