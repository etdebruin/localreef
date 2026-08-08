/**
 * Session restore, driven through the real renderer.
 *
 *   electron test/electron/session-restore.mjs   (part of npm run test:electron:ui)
 *
 * Closing the shell must not cost the arrangement: on the next start the
 * renderer is handed the previous session and has to rebuild it — same apps,
 * same positions, same sizes, same minimized state, same stacking — and then
 * keep the on-disk session current as windows move, close, and minimize.
 * All of that is renderer behaviour, so nothing in `npm test` can see it.
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

process.on('unhandledRejection', (err) => {
  console.log(`\n  ❌ harness crashed: ${err?.stack ?? err}`)
  app.exit(1)
})

// What the previous session supposedly looked like. `ghost` exercises the
// case of an app that was uninstalled between sessions — it must be skipped,
// not restored broken. Order is z-order: probe is meant to end up on top of
// nothing (feed-reader is minimized), but *after* probe in the array.
const SESSION = {
  main: null,
  windows: [
    { id: 'probe', left: 200, top: 120, width: 640, height: 400, minimized: false },
    { id: 'ghost', left: 10, top: 40, width: 400, height: 300, minimized: false },
    { id: 'feed-reader', left: 430, top: 210, width: 520, height: 360, minimized: true },
  ],
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

  const js = (code) =>
    win.webContents.executeJavaScript(code).catch((err) => ({ __error: String(err.message ?? err) }))

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

  await win.loadFile(path.join(projectRoot, 'src/renderer/index.html'), {
    query: { session: JSON.stringify(SESSION) },
  })
  await wait(1200)

  // --- the desktop reassembles itself ---
  const windows = await js(`(() => {
    const list = {}
    for (const el of document.querySelectorAll('.window')) {
      const name = el.querySelector('.titlebar .name')?.textContent
      list[name] = {
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
        hidden: el.hidden,
        z: Number(el.style.zIndex),
        focused: el.classList.contains('focused'),
      }
    }
    return list
  })()`)

  check(
    'both surviving apps reopen; the uninstalled one is skipped',
    windows && Object.keys(windows).length === 2 && windows.Probe && windows['Feed Reader'],
    JSON.stringify(Object.keys(windows ?? {})),
  )
  check(
    'a window reopens exactly where it was',
    windows?.Probe?.left === 200 && windows.Probe.top === 120,
    JSON.stringify(windows?.Probe),
  )
  check(
    'a window reopens exactly the size it was',
    windows?.Probe?.width === 640 && windows.Probe.height === 400,
    JSON.stringify(windows?.Probe),
  )
  check(
    'a minimized window comes back minimized',
    windows?.['Feed Reader']?.hidden === true,
    JSON.stringify(windows?.['Feed Reader']),
  )
  check(
    'the visible window has focus, not the minimized one',
    windows?.Probe?.focused === true,
    JSON.stringify(windows),
  )

  const dockMin = await js(`(() => {
    const buttons = [...document.querySelectorAll('.dock-app')]
    const fr = buttons.find((b) => b.title.includes('Feed Reader'))
    return { running: fr?.classList.contains('running'), min: fr?.classList.contains('minimized') }
  })()`)
  check(
    'the dock shows the restored minimized app as parked',
    dockMin?.running === true && dockMin.min === true,
    JSON.stringify(dockMin),
  )

  // --- restoring also re-persists: the session should survive a no-op run ---
  await wait(600)
  const echoed = await js(`window.reef.__savedSession()`)
  check(
    'the restored arrangement is persisted back as-is',
    Array.isArray(echoed) &&
      echoed.length === 2 &&
      echoed.some((w) => w.id === 'probe' && w.left === 200 && w.width === 640 && !w.minimized) &&
      echoed.some((w) => w.id === 'feed-reader' && w.minimized === true),
    JSON.stringify(echoed),
  )

  // A minimized window is display:none, where every offset* reads 0 — the
  // session must still carry its real geometry or parking a window wipes
  // where it was.
  const parked = echoed?.find?.((w) => w.id === 'feed-reader')
  check(
    'a minimized window keeps its geometry in the session',
    Boolean(parked) && parked.left === 430 && parked.top === 210 && parked.width === 520 && parked.height === 360,
    JSON.stringify(parked),
  )

  // --- moving a window updates the session ---
  const titlePoint = await centreOf('.window:not([hidden]) .titlebar .name')
  if (titlePoint) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: titlePoint.x, y: titlePoint.y, button: 'left', clickCount: 1 })
    await wait(60)
    for (let step = 1; step <= 5; step += 1) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: titlePoint.x + step * 12,
        y: titlePoint.y + step * 10,
        button: 'left',
        movementX: 12,
        movementY: 10,
      })
      await wait(30)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: titlePoint.x + 60, y: titlePoint.y + 50, button: 'left', clickCount: 1 })
    await wait(600)
  }

  const afterMove = await js(`window.reef.__savedSession()`)
  const movedProbe = afterMove?.find?.((w) => w.id === 'probe')
  check(
    'dragging a window persists its new position',
    Boolean(movedProbe) && movedProbe.left === 260 && movedProbe.top === 170,
    JSON.stringify(movedProbe),
  )

  // --- closing a window removes it from the session ---
  const closePoint = await centreOf('.window:not([hidden]) .titlebar button.close')
  if (closePoint) await clickAt(closePoint)
  await wait(600)

  const afterClose = await js(`window.reef.__savedSession()`)
  check(
    'closing a window drops it from the session',
    Array.isArray(afterClose) && afterClose.length === 1 && afterClose[0].id === 'feed-reader',
    JSON.stringify(afterClose),
  )

  // --- restoring a minimized window is recorded too ---
  const dockPoint = await js(`(() => {
    const el = [...document.querySelectorAll('.dock-app')].find((b) => b.title.includes('Feed Reader'))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (dockPoint) await clickAt(dockPoint)
  await wait(600)

  const afterRestore = await js(`window.reef.__savedSession()`)
  check(
    'un-minimizing from the dock persists as not minimized',
    afterRestore?.length === 1 && afterRestore[0].id === 'feed-reader' && afterRestore[0].minimized === false,
    JSON.stringify(afterRestore),
  )

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
