/**
 * User settings.
 *
 * Two things live here, and they share a file for the same reason: both are
 * machine-local configuration that the app cannot discover for itself.
 *
 * `appsFolder` is a directory the user keeps projects in. We scan it for apps
 * that have opted in with a `reef.json` (see `scanApps`).
 *
 * `anthropicApiKey` exists because launching from Finder or the Dock inherits
 * no shell environment, so `ANTHROPIC_API_KEY` is simply absent and ⌘K fails
 * with nothing to say for itself. Same class of problem as the missing PATH
 * that `supervisor.js` already solves. The environment still wins nothing —
 * a configured key is preferred, the environment is the fallback.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = { appsFolder: null, anthropicApiKey: null }

/** Fields we persist. Anything else in the file is dropped on write. */
const KEYS = Object.keys(DEFAULTS)

/** `~/Code` typed into a text field should mean what it means in a shell. */
export function expandHome(value) {
  const text = String(value ?? '')
  if (text !== '~' && !text.startsWith(`~${path.sep}`) && !text.startsWith('~/')) return text
  return path.join(os.homedir(), text.slice(1))
}

function clean(value) {
  const text = String(value ?? '').trim()
  return text === '' ? null : text
}

function normalise(raw) {
  const settings = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return settings

  settings.anthropicApiKey = clean(raw.anthropicApiKey)

  const folder = clean(raw.appsFolder)
  settings.appsFolder = folder ? path.resolve(expandHome(folder)) : null

  return settings
}

/**
 * A configured key beats the environment, so setting one in the UI takes
 * effect without relaunching from a terminal.
 */
export function resolveApiKey(settings = {}, env = process.env) {
  return clean(settings.anthropicApiKey) ?? clean(env.ANTHROPIC_API_KEY)
}

export function createSettingsStore(file) {
  async function read() {
    try {
      return normalise(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch {
      // Missing or corrupt. Same posture as links.json: never let unreadable
      // configuration stop the desktop from starting.
      return { ...DEFAULTS }
    }
  }

  async function update(patch = {}) {
    const merged = { ...(await read()) }
    for (const key of KEYS) {
      if (key in patch) merged[key] = patch[key]
    }

    const settings = normalise(merged)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    return settings
  }

  return { read, update }
}
