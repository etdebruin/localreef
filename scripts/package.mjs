/**
 * Build Local Reef.app.
 *
 *   npm run build:mac
 *
 * Produces dist/Local Reef-darwin-<arch>/Local Reef.app, which can be dragged
 * to /Applications and kept in the Dock — or put there for you by
 * `npm run install:mac`, which calls buildApp() below.
 *
 * Unsigned: this is a local build for the machine that made it. macOS will
 * quarantine a copy that arrives from anywhere else.
 */

import { packager } from '@electron/packager'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Everything the packaged app is built from — what install:mac watches. */
export const SOURCES = ['src', 'apps', 'package.json', 'build/icon.icns']

/** Returns the path to the built Local Reef.app. */
export async function buildApp() {
  const icon = path.join(projectRoot, 'build/icon.icns')
  try {
    await fs.access(icon)
  } catch {
    throw new Error('build/icon.icns is missing — run `npm run icon` first.')
  }

  const [out] = await packager({
    dir: projectRoot,
    out: path.join(projectRoot, 'dist'),
    overwrite: true,
    icon,
    appBundleId: 'com.localreef.app',
    appCategoryType: 'public.app-category.developer-tools',

    // What macOS shows in the system prompt. Without these it uses Electron's
    // generic "This app needs access to the microphone", which tells the user
    // nothing about which of their apps is asking or why.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'An app you opened in Local Reef wants to record audio. Only apps that declare it in their manifest can ask.',
      NSCameraUsageDescription:
        'An app you opened in Local Reef wants to use the camera. Only apps that declare it in their manifest can ask.',
    },

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

  return path.join(out, 'Local Reef.app')
}

// Only when run directly — install.mjs imports buildApp() instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildApp()
  console.log(`\n  ${built}`)
}
