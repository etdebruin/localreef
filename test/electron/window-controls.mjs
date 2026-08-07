/**
 * Window chrome behaviour, driven by real Chromium input events.
 *
 *   npm run test:electron:ui
 *
 * Uses sendInputEvent rather than element.click() on purpose. A programmatic
 * .click() dispatches straight to the element and skips the pointer sequence
 * entirely — it would have passed happily while the close button was broken by
 * the titlebar capturing the pointer.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    x: 60,
    y: 60,
    show: true,
    webPreferences: {
      preload: path.join(here, 'stub-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('console-message', (...args) => {
    const d = typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const level = d ? d.level : args[1]
    const message = d ? d.message : args[2]
    if (level === 'error' || level >= 2) console.log(`  [renderer error] ${message}`)
  })

  await win.loadFile(path.join(projectRoot, 'src/renderer/index.html'))
  await wait(700)

  const js = (code) => win.webContents.executeJavaScript(code)

  /** Centre of the first element matching `selector`, in page coordinates. */
  const centreOf = (selector) =>
    js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

  async function clickAt({ x, y }) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await wait(40)
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await wait(260)
  }

  // --- open a window by clicking its icon ---
  const iconPoint = await centreOf('.icon')
  check('icon is rendered', Boolean(iconPoint))
  if (iconPoint) await clickAt(iconPoint)

  const openCount = await js(`document.querySelectorAll('.window').length`)
  check('clicking the icon opens a window', openCount === 1, `windows=${openCount}`)

  // --- drag it by the titlebar ---
  const before = await js(`(() => { const w = document.querySelector('.window'); return { left: w.offsetLeft, top: w.offsetTop } })()`)
  const titlePoint = await centreOf('.window .titlebar .name')

  // Instrument: where do pointermove events actually land?
  await js(`
    window.__probe = { doc: 0, handle: 0, xs: [] }
    document.addEventListener('pointermove', (e) => {
      window.__probe.doc++
      window.__probe.xs.push(e.clientX)
    }, true)
    document.querySelector('.window .titlebar')
      .addEventListener('pointermove', () => window.__probe.handle++)
    true
  `)

  if (titlePoint) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: titlePoint.x, y: titlePoint.y, button: 'left', clickCount: 1 })
    await wait(60)

    // Did the drag actually begin? The shield going visible is the signal that
    // the pointerdown handler ran at all.
    const midDrag = await js(`document.getElementById('shield').hidden`)
    check('pointerdown starts a drag (shield raised)', midDrag === false, `shield.hidden=${midDrag}`)

    // Step the pointer the way a hand would; one big jump can be coalesced or
    // dropped, which would make a working drag look broken.
    for (let step = 1; step <= 6; step += 1) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: titlePoint.x + step * 20,
        y: titlePoint.y + step * 12,
        button: 'left',
        movementX: 20,
        movementY: 12,
      })
      await wait(30)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: titlePoint.x + 120, y: titlePoint.y + 72, button: 'left', clickCount: 1 })
    await wait(220)
  }

  const probe = await js(`window.__probe`)
  console.log(`  [probe] pointermove seen — document:${probe.doc} titlebar:${probe.handle}`)
  console.log(`  [probe] pointerdown x=${titlePoint?.x}; pointermove clientX values: ${JSON.stringify(probe.xs)}`)

  const styleLeft = await js(`(() => { const w = document.querySelector('.window'); return w ? w.style.left : null })()`)
  console.log(`  [probe] window style.left after drag = ${styleLeft}`)

  const after = await js(`(() => { const w = document.querySelector('.window'); return w ? { left: w.offsetLeft, top: w.offsetTop } : null })()`)
  check(
    'dragging the titlebar moves the window',
    Boolean(after) && (after.left !== before.left || after.top !== before.top),
    `${before.left},${before.top} -> ${after ? `${after.left},${after.top}` : 'gone'}`,
  )

  // The shield must not be left covering the desktop after a drag.
  const shieldHidden = await js(`document.getElementById('shield').hidden`)
  check('the drag shield is released afterwards', shieldHidden === true)

  // --- the actual bug: close via the X ---
  const closePoint = await centreOf('.window .titlebar button')
  check('close button is present', Boolean(closePoint))
  if (closePoint) await clickAt(closePoint)

  const remaining = await js(`document.querySelectorAll('.window').length`)
  check('clicking X closes the window', remaining === 0, `windows=${remaining}`)

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
