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

// Same reasoning as the js() guard: whatever happens, report and exit.
process.on('unhandledRejection', (err) => {
  console.log(`\n  ❌ harness crashed: ${err?.stack ?? err}`)
  app.exit(1)
})

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

  // Never let a throwing probe abort the run. An exception in executeJavaScript
  // rejects up through this async chain, app.exit() is never reached, and the
  // harness sits there with a window open until something kills it — which
  // reads as a hang rather than a failure.
  const js = (code) =>
    win.webContents.executeJavaScript(code).catch((err) => ({ __error: String(err.message ?? err) }))

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

  // --- icons are square, uniform, and mode-appropriate ---
  const tiles = await js(`(() => [...document.querySelectorAll('.dock-app .tile')].map((el) => {
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className }
  }))()`)

  check('every app has a tile', Array.isArray(tiles) && tiles.length === 2, JSON.stringify(tiles))
  check(
    'every tile is square',
    tiles.length > 0 && tiles.every((t) => t.w === t.h && t.w > 0),
    JSON.stringify(tiles.map((t) => `${t.w}x${t.h}`)),
  )
  check(
    'every tile is the same size',
    new Set(tiles.map((t) => t.w)).size === 1,
    `sizes=${[...new Set(tiles.map((t) => t.w))]}`,
  )
  check(
    'a declared emoji renders as an emoji tile',
    tiles.some((t) => t.cls.includes('tile--emoji')),
  )
  check(
    'an app with no icon falls back to a generated tile',
    tiles.some((t) => t.cls.includes('tile--generated')),
  )

  // The generated tile's colour must actually resolve — an unsupported oklch()
  // or an unset --hue would silently render a transparent square.
  const generated = await js(`(() => {
    const el = document.querySelector('.tile--generated')
    if (!el) return null
    const s = getComputedStyle(el)
    return { hue: s.getPropertyValue('--hue').trim(), bg: s.backgroundImage.slice(0, 40) }
  })()`)
  check(
    'the generated tile resolves a real colour',
    generated?.hue === '212' && generated.bg.includes('gradient'),
    JSON.stringify(generated),
  )

  // --- open a window from the dock ---
  const iconPoint = await centreOf('.dock-app')
  check('the app appears in the dock', Boolean(iconPoint))
  if (iconPoint) await clickAt(iconPoint)

  const openCount = await js(`document.querySelectorAll('.window').length`)
  check('clicking the dock icon opens a window', openCount === 1, `windows=${openCount}`)

  // Running apps are marked in the dock, the way macOS does it.
  const runningDot = await js(`document.querySelector('.dock-app')?.classList.contains('running') ?? null`)
  check('the dock marks the app as running', runningDot === true)

  // The titlebar carries the same tile as the dock, so an app looks like
  // itself in both places. It is small, so verify it actually renders its
  // contents rather than showing a bare coloured square.
  const titleTile = await js(`(() => {
    const el = document.querySelector('.window .titlebar .tile-sm')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const inner = el.querySelector('.tile-glyph, .tile-initials, img')
    const ir = inner?.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      kind: el.className,
      text: inner?.textContent ?? null,
      innerVisible: Boolean(ir && ir.width > 0 && ir.height > 0),
    }
  })()`)
  check('the titlebar shows a tile', Boolean(titleTile), JSON.stringify(titleTile))
  check(
    'the titlebar tile is square',
    titleTile && titleTile.w === titleTile.h && titleTile.w > 0,
    `${titleTile?.w}x${titleTile?.h}`,
  )
  check(
    'the titlebar tile renders its contents',
    titleTile?.innerVisible === true,
    JSON.stringify(titleTile),
  )

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

  // The drag has made its assertion; put the window back at a known position
  // so everything after it clicks at predictable coordinates. Physical mouse
  // movement over the harness window mixes real pointermove events into the
  // synthetic drag, and a window left off at x=1036 puts the titlebar buttons
  // outside the viewport — every later check then fails for the wrong reason.
  await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return false
    w.style.left = '90px'
    w.style.top = '70px'
    return true
  })()`)
  await wait(80)

  // --- minimize sends the window to the dock, not to oblivion ---
  const minPoint = await centreOf('.window .titlebar button.minimize')
  check('minimize button is present', Boolean(minPoint))
  if (minPoint) await clickAt(minPoint)

  // Assert it actually vanished, not merely that the property flipped. The
  // `hidden` attribute only hides via a UA rule, and any author-level display
  // rule outranks it — .window sets display:flex, so setting hidden looked
  // right in the DOM while the window stayed fully on screen.
  const minimized = await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return { present: false }
    const r = w.getBoundingClientRect()
    return {
      present: true,
      hidden: w.hidden,
      onScreen: r.width > 0 && r.height > 0,
      display: getComputedStyle(w).display,
    }
  })()`)
  check(
    'minimize takes the window off screen',
    minimized.present === true && minimized.onScreen === false,
    JSON.stringify(minimized),
  )
  check(
    'minimize does not destroy the window',
    minimized.present === true && minimized.hidden === true,
    JSON.stringify(minimized),
  )

  // The app is still running, so the dock must still say so — and say it is
  // parked. Losing the window with no way back is the failure mode here.
  const dockState = await js(`(() => {
    const el = document.querySelector('.dock-app')
    if (!el) return { running: null, min: null }
    return { running: el.classList.contains('running'), min: el.classList.contains('minimized') }
  })()`)
  check(
    'the dock shows it minimized and still running',
    dockState.running === true && dockState.min === true,
    JSON.stringify(dockState),
  )

  // --- clicking the dock icon brings it back ---
  const restorePoint = await centreOf('.dock-app')
  if (restorePoint) await clickAt(restorePoint)

  const restored = await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return { present: false }
    const r = w.getBoundingClientRect()
    return { present: true, hidden: w.hidden, onScreen: r.width > 0 && r.height > 0 }
  })()`)
  check(
    'clicking the dock icon puts it back on screen',
    restored.hidden === false && restored.onScreen === true,
    JSON.stringify(restored),
  )

  const stillOne = await js(`document.querySelectorAll('.window').length`)
  check('restoring does not open a second window', stillOne === 1, `windows=${stillOne}`)

  // --- the actual bug: close via the X ---
  const closePoint = await centreOf('.window .titlebar button.close')
  check('close button is present', Boolean(closePoint))
  if (closePoint) await clickAt(closePoint)

  const remaining = await js(`document.querySelectorAll('.window').length`)
  check('clicking X closes the window', remaining === 0, `windows=${remaining}`)

  const stoppedDot = await js(`document.querySelector('.dock-app')?.classList.contains('running') ?? null`)
  check('closing clears the running mark', stoppedDot === false)

  // --- settings: open, edit, save ---
  const settingsPoint = await centreOf('#open-settings')
  check('settings button is present', Boolean(settingsPoint))
  if (settingsPoint) await clickAt(settingsPoint)

  const settingsOpen = await js(`document.getElementById('settings').hidden`)
  check('clicking Settings opens the sheet', settingsOpen === false, `hidden=${settingsOpen}`)

  // The stub reports a saved key and a configured folder; the sheet has to
  // reflect that rather than showing empty fields.
  const folderValue = await js(`document.getElementById('apps-folder').value`)
  check('the configured folder is populated', folderValue === '/tmp/projects', `value=${folderValue}`)

  // The key must never be sent to the renderer — only its presence.
  const keyValue = await js(`document.getElementById('api-key').value`)
  const keyPlaceholder = await js(`document.getElementById('api-key').placeholder`)
  check('the API key field stays empty', keyValue === '', `value=${JSON.stringify(keyValue)}`)
  check('a saved key is signalled by placeholder', /saved/i.test(keyPlaceholder), keyPlaceholder)

  // Type a new folder, then save via a real click.
  await js(`(() => {
    const el = document.getElementById('apps-folder')
    el.value = '/tmp/other'
    return true
  })()`)

  const savePoint = await centreOf('#save-settings')
  if (savePoint) await clickAt(savePoint)
  await wait(250)

  const saved = await js(`window.reef.__savedSettings()`)
  check(
    'saving sends the folder to the main process',
    saved?.appsFolder === '/tmp/other',
    JSON.stringify(saved),
  )

  // An untouched key field must not wipe the saved key.
  check(
    'an untouched key field is not sent',
    saved && !('anthropicApiKey' in saved),
    JSON.stringify(saved),
  )

  const closedAfterSave = await js(`document.getElementById('settings').hidden`)
  check('saving closes the sheet', closedAfterSave === true, `hidden=${closedAfterSave}`)

  // --- escape closes it too ---
  if (settingsPoint) await clickAt(settingsPoint)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(150)

  const closedByEsc = await js(`document.getElementById('settings').hidden`)
  check('escape closes settings', closedByEsc === true, `hidden=${closedByEsc}`)

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
