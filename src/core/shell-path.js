/**
 * Recovering the user's PATH from a login shell.
 *
 * A GUI-launched Electron app inherits `/usr/bin:/bin` and nothing else, so
 * `node`, `uv`, `pnpm` and friends are simply missing. The fix is to ask a
 * login shell — but a login shell's stdout is not a clean channel:
 *
 *   - macOS Terminal's session restore prints "Restored session: ..." to
 *     *stdout* from an interactive zsh
 *   - version managers, greeters and motd scripts print whatever they like
 *
 * So the shell is asked to emit a marker, and only what follows the last one
 * is treated as PATH. Everything before it is somebody else's output.
 */

import os from 'node:os'
import path from 'node:path'

export const PATH_MARKER = '__REEF_PATH__='

/**
 * Where things actually get installed, appended when the login shell fails or
 * times out. A slow rc file should degrade to "most apps still start" rather
 * than to "nothing starts".
 */
const FALLBACKS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

/** @returns the PATH the shell reported, or null if it never reported one. */
export function parseShellPath(stdout) {
  const text = String(stdout ?? '')
  const at = text.lastIndexOf(PATH_MARKER)
  if (at === -1) return null

  const value = text.slice(at + PATH_MARKER.length).trim()
  return value === '' ? null : value
}

/** Resolved entries first, then the usual suspects, deduped. */
export function withFallbacks(resolved) {
  const seen = new Set()
  const out = []

  for (const entry of [...String(resolved ?? '').split(':'), ...FALLBACKS]) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }

  return out.join(':')
}
