/**
 * Build Local Reef.app.
 *
 *   npm run build:mac
 *
 * Produces dist/Local Reef-darwin-<arch>/Local Reef.app, which can be dragged
 * to /Applications and kept in the Dock.
 *
 * Unsigned: this is a local build for the machine that made it. macOS will
 * quarantine a copy that arrives from anywhere else.
 */

import { packager } from '@electron/packager'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const icon = path.join(projectRoot, 'build/icon.icns')
try {
  await fs.access(icon)
} catch {
  console.error('build/icon.icns is missing — run `npm run icon` first.')
  process.exit(1)
}

const paths = await packager({
  dir: projectRoot,
  out: path.join(projectRoot, 'dist'),
  overwrite: true,
  icon,
  appBundleId: 'com.localreef.app',
  appCategoryType: 'public.app-category.developer-tools',

  // asar is off deliberately. Server apps are spawned with their own folder as
  // cwd, and a child process cannot have its working directory inside an asar
  // archive — apps/clock would fail to start in a packaged build while working
  // perfectly from source.
  asar: false,

  ignore: [
    /^\/dist($|\/)/,
    /^\/\.shots($|\/)/,
    /^\/\.git($|\/)/,
    /^\/test($|\/)/,
    /^\/scripts($|\/)/,
    /^\/build\/icon\.iconset($|\/)/,
    /^\/build\/icon-render\.html$/,
  ],
})

for (const out of paths) {
  console.log(`\n  ${out}`)
  const appPath = path.join(out, 'Local Reef.app')
  const { size } = await fs.stat(appPath).catch(() => ({ size: 0 }))
  if (size) console.log(`  Local Reef.app built`)
}
