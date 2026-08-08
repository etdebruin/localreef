/**
 * Build Local Reef.app and put it in /Applications.
 *
 *   npm run install:mac            # rebuild only if src/ is newer
 *   npm run install:mac -- --force # rebuild regardless
 *
 * Why this exists: `npm start` and the app in the Dock are different code. A
 * change to src/ is invisible to the Dock until the bundle is rebuilt, and
 * that gap cost a whole debugging round — a fix was verified working from
 * source while the installed app, launched from the Dock, still had the bug.
 *
 * Cheap to call. It compares mtimes first and exits silently when the
 * installed bundle is already newer than every source file, which makes it
 * safe to wire to a hook that fires on every turn.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { buildApp, projectRoot, SOURCES } from './package.mjs'

const run = promisify(execFile)
const INSTALLED = '/Applications/Local Reef.app'

/** Newest mtime under a file or directory tree, or 0 if it does not exist. */
async function newestMtime(target) {
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.mtimeMs

  const entries = await fs.readdir(target, { withFileTypes: true })
  const times = await Promise.all(
    entries
      // node_modules and build output are not sources, and walking them turns a
      // millisecond check into a multi-second one.
      .filter((e) => e.name !== 'node_modules' && e.name !== 'dist' && !e.name.startsWith('.'))
      .map((e) => newestMtime(path.join(target, e.name))),
  )
  return Math.max(stat.mtimeMs, ...times, 0)
}

const force = process.argv.includes('--force')
const sources = await Promise.all(SOURCES.map((s) => newestMtime(path.join(projectRoot, s))))
const newest = Math.max(...sources)
const installed = await newestMtime(INSTALLED)

if (!force && installed > newest) process.exit(0)

console.log(installed ? 'Local Reef.app is stale — rebuilding…' : 'Installing Local Reef.app…')

const built = await buildApp()

// ditto rather than cp: it preserves the bundle's extended attributes, and
// replacing in place keeps the Dock entry pointing at the same path.
await fs.rm(INSTALLED, { recursive: true, force: true })
await run('ditto', [built, INSTALLED])

// The copy is only "newer" if its mtime says so, and ditto preserves the
// source's. Without this the next run would rebuild all over again.
const now = new Date()
await fs.utimes(INSTALLED, now, now)

console.log(`  installed → ${INSTALLED}`)
