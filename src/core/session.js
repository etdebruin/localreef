/**
 * Desktop session state.
 *
 * What was on screen when the shell window went away: the main window's
 * bounds, and each open app window's geometry, in z-order. Closing the shell
 * with ⌘W or the red dot must not cost the arrangement — reopening it puts
 * every window back where it was.
 *
 * Same file-store shape as settings.js and links.json, and the same failure
 * posture: an unreadable session starts the desktop empty, never broken.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = { main: null, windows: [] }

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Reject rather than repair: garbage geometry restores as no window at all. */
function normaliseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  if (![raw.left, raw.top, raw.width, raw.height].every(finite)) return null

  return {
    id,
    left: Math.round(raw.left),
    top: Math.round(raw.top),
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    minimized: Boolean(raw.minimized),
  }
}

function normaliseMain(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (![raw.x, raw.y, raw.width, raw.height].every(finite)) return null
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(raw.width),
    height: Math.round(raw.height),
  }
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  return {
    main: normaliseMain(raw.main),
    windows: (Array.isArray(raw.windows) ? raw.windows : [])
      .map(normaliseWindow)
      .filter(Boolean),
  }
}

export function createSessionStore(file) {
  async function read() {
    try {
      return normalise(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch {
      return { ...DEFAULTS }
    }
  }

  async function update(patch = {}) {
    const merged = { ...(await read()) }
    if ('main' in patch) merged.main = patch.main
    if ('windows' in patch) merged.windows = patch.windows

    const session = normalise(merged)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
    return session
  }

  return { read, update }
}
