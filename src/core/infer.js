/**
 * Working out what an app is without being told.
 *
 * The manifest is optional by design, so these rules carry most app folders on
 * their own. See MANIFEST.md for the table these mirror.
 */

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

export function detectPackageManager(files = []) {
  const present = new Set(files)
  for (const [lockfile, manager] of LOCKFILES) {
    if (present.has(lockfile)) return manager
  }
  return 'npm'
}

/** `start` is the one script every manager exposes without a `run` prefix. */
function scriptCommand(manager, script) {
  return script === 'start' ? `${manager} start` : `${manager} run ${script}`
}

export function detectAppType({ files = [], pkg = null } = {}) {
  const present = new Set(files)
  const hasIndex = present.has('index.html')
  const scripts = pkg?.scripts ?? {}

  // No package.json means no build step, so the folder is already the site.
  if (hasIndex && !pkg) {
    return { type: 'static', root: '.' }
  }

  const manager = detectPackageManager(files)
  if (scripts.dev) return { type: 'server', run: scriptCommand(manager, 'dev') }
  if (scripts.start) return { type: 'server', run: scriptCommand(manager, 'start') }

  // A package.json with no dev/start implies a build, so prefer its output.
  if (hasIndex) {
    return { type: 'static', root: present.has('dist') ? 'dist' : '.' }
  }

  return {
    type: null,
    reason:
      'No index.html, and no dev or start script in package.json. ' +
      'Add one, or set "type" and "run" in desktop.json.',
  }
}
