/**
 * Electron main process.
 *
 * Wires the three pieces together: registry (what apps exist), supervisor
 * (which are running), gateway (how the browser reaches them), and hands the
 * renderer a URL per app.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import fs from 'node:fs/promises'

import { scanApps, readApp } from '../core/registry.js'
import { createLinkStore } from '../core/links.js'
import { createSettingsStore, resolveApiKey } from '../core/settings.js'
import { readIconImage, isImageIcon, initialsFor, hueFor } from '../core/icon.js'
import { createSupervisor } from './supervisor.js'
import { createGateway } from '../gateway/index.js'
import { AUTH_PARAM, AUTH_HEADER } from '../gateway/auth.js'
import { createGenerator, createFixer, createClaudeRunner } from './agent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')

// Guarantee *.desktop.localhost resolves to loopback rather than trusting the
// system resolver to do the RFC 6761 thing.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.desktop.localhost 127.0.0.1')

const TOKEN = crypto.randomBytes(24).toString('hex')

const NO_KEY = 'No Anthropic API key. Add one in Settings, or set ANTHROPIC_API_KEY and relaunch.'

let links = null
let settings = null
let mainWindow = null
let gateway = null
let apps = new Map()

const supervisor = createSupervisor({
  onChange: (id, state) => {
    mainWindow?.webContents.send('apps:state', { id, ...state })
  },
})

/** Curated directories: bundled samples, plus whatever ⌘K has generated. */
function appDirectories() {
  return [path.join(projectRoot, 'apps'), path.join(app.getPath('userData'), 'apps')]
}

async function refreshApps() {
  const curated = await Promise.all(appDirectories().map((dir) => scanApps(dir)))

  // The user's own projects folder. Discovery here is opt-in — only folders
  // carrying a desktop.json — because it is a working directory, not a
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
    ...curated.flat(),
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
    return { kind: 'emoji', image: null, glyph: record.icon, initials: null, hue: null }
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
  const base = `http://${id}.desktop.localhost:${gateway.port}/`
  return withToken ? `${base}?${AUTH_PARAM}=${TOKEN}` : base
}

function serialise(record) {
  const state = supervisor.get(record.id)
  return {
    id: record.id,
    dir: record.dir,
    linked: record.linked ?? false,
    discovered: record.discovered ?? false,
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Local Desktop',
    backgroundColor: '#11131a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Surface renderer problems in the terminal. Without this a thrown error in
  // renderer.js is an invisible blank desktop.
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron changed this signature mid-life: older builds pass positional
    // arguments, newer ones a details object.
    const details = typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const level = details ? details.level : args[1]
    const message = details ? details.message : args[2]
    const source = details ? `${details.sourceId}:${details.lineNumber}` : `${args[4]}:${args[3]}`
    if (level === 'error' || level === 'warning' || level >= 2) {
      console.error(`[renderer] ${message}  (${source})`)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  await mainWindow.loadFile(path.join(projectRoot, 'src/renderer/index.html'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  links = createLinkStore(path.join(app.getPath('userData'), 'links.json'))
  settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'))

  // Authenticate framed apps by header rather than cookie. An app iframe is a
  // cross-site context relative to the file:// renderer, so a SameSite=Lax
  // cookie gets stored and then never sent back — the app would load once and
  // 401 on the redirect. Scoped strictly to app origins so the token cannot
  // leak anywhere else.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.desktop.localhost/*'] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    },
  )

  gateway = createGateway({ token: TOKEN, lookup: (id) => lookupForGateway(id) })
  await gateway.listen(0)

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

  return { ok: true, url: urlFor(id, { withToken: true }), name: record.name, icon: record.icon }
})

ipcMain.handle('apps:stop', async (_event, id) => {
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

ipcMain.handle('settings:get', async () => {
  const current = await settings.read()
  return {
    ...current,
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
ipcMain.handle('apps:generate', async (_event, prompt) => {
  if (!String(prompt ?? '').trim()) return { ok: false, error: 'Describe what to build.' }

  const apiKey = resolveApiKey(await settings.read())
  if (!apiKey) return { ok: false, error: NO_KEY }

  const generatedDir = path.join(app.getPath('userData'), 'apps')
  await fs.mkdir(generatedDir, { recursive: true })

  const generator = createGenerator({
    appsDir: generatedDir,
    runAgent: createClaudeRunner({ apiKey }),
  })

  const result = await generator.generate({
    prompt,
    onProgress: (progress) => mainWindow?.webContents.send('apps:generating', progress),
  })

  if (result.ok) await refreshApps()
  return result
})

ipcMain.handle('apps:fix', async (_event, id) => {
  const record = apps.get(id)
  if (!record) return { ok: false, error: `No app called "${id}"` }

  const apiKey = resolveApiKey(await settings.read())
  if (!apiKey) return { ok: false, error: NO_KEY }

  const state = supervisor.get(id)
  const fixer = createFixer({ runAgent: createClaudeRunner({ apiKey }) })

  const result = await fixer.fix({
    id,
    dir: record.dir,
    name: record.name,
    // A registry error (unreadable manifest) and a runtime crash are both
    // "why this app will not open"; the model gets whichever applies.
    error: record.error ?? state.error ?? 'The app failed to start.',
    logs: state.logs ?? [],
    onProgress: (progress) => mainWindow?.webContents.send('apps:fixing', progress),
  })

  // Drop the old process so the next launch picks up the edited files.
  if (result.ok) {
    await supervisor.stop(id)
    await refreshApps()
  }

  return result
})

async function shutdown() {
  await supervisor.stopAll()
  await gateway?.close()
}

app.on('window-all-closed', async () => {
  await shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', shutdown)
