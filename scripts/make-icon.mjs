/**
 * Render assets/icon.svg into a macOS .icns.
 *
 *   npm run icon
 *
 * Rasterises through Electron rather than a native SVG tool, because Electron
 * is already a dependency and Chromium is the renderer the app itself uses —
 * one fewer thing to install, and no chance of a converter disagreeing with
 * what the shell would draw.
 *
 * Writes build/icon.iconset/*.png and then calls iconutil, which is what
 * actually produces the .icns.
 */

import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const iconset = path.join(projectRoot, 'build/icon.iconset')

/** The exact set `iconutil` expects; anything missing makes a poorer icns. */
const VARIANTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

app.disableHardwareAcceleration()

// Each variant destroys its window, and Electron quits by default once the
// last one closes — which ended the run silently after the first icon.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const svg = await fs.readFile(path.join(projectRoot, 'assets/icon.svg'), 'utf8')
  await fs.rm(iconset, { recursive: true, force: true })
  await fs.mkdir(iconset, { recursive: true })

  // Transparent window: the squircle's corners must stay transparent, not
  // pick up a white page behind them.
  // The SVG is drawn at the exact target size and captured from the top-left
  // corner, so every variant is a true vector render rather than one big
  // render downsampled — which is the whole point of drawing it.
  const pageFor = (size) => `<!doctype html>
    <style>
      html, body { margin: 0; background: transparent; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style>
    ${svg}`

  const pageFile = path.join(projectRoot, 'build/icon-render.html')

  const written = []
  for (const [name, size] of VARIANTS) {
    // A file, not a data: URL — the inlined SVG is far past what loadURL
    // accepts and it fails with a bare ERR_FAILED.
    await fs.writeFile(pageFile, pageFor(size), 'utf8')

    // macOS refuses to create a window as small as 16x16, and the load then
    // fails with ERR_FAILED rather than anything that names the real problem.
    // Keep the window comfortably large and crop the corner instead.
    const windowSize = Math.max(size, 320)
    const win = new BrowserWindow({
      width: windowSize,
      height: windowSize,
      show: false,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
    })

    await win.loadFile(pageFile)
    await new Promise((r) => setTimeout(r, 140))

    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    const png = image.toPNG()
    await fs.writeFile(path.join(iconset, name), png)
    written.push(`${name.padEnd(22)} ${String(png.length).padStart(7)} bytes`)
    win.destroy()
  }

  const icns = path.join(projectRoot, 'build/icon.icns')
  await run('iconutil', ['-c', 'icns', iconset, '-o', icns])

  // The packager wants a 512 PNG too, and it is useful on its own.
  await fs.copyFile(path.join(iconset, 'icon_512x512@2x.png'), path.join(projectRoot, 'build/icon.png'))

  await fs.rm(pageFile, { force: true })
  const { size } = await fs.stat(icns)
  console.log(written.map((w) => `  ${w}`).join('\n'))
  console.log(`\n  ${icns}  (${(size / 1024).toFixed(0)} KB)`)
  app.exit(0)
})

process.on('unhandledRejection', (err) => {
  console.error(`icon build failed: ${err?.stack ?? err}`)
  app.exit(1)
})
