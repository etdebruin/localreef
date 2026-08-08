/**
 * The startup hello, driven by real Chromium input.
 *
 *   electron test/electron/greeting.mjs   (part of npm run test:electron:ui)
 *
 * Two things matter here and neither can be proven from Node:
 *
 * 1. Non-blocking. The greeting must never cost a click or steal the
 *    keyboard. That is a hit-testing and focus question only a real page can
 *    answer — elementFromPoint, document.activeElement, and an actual click
 *    on the dock while the card is up.
 * 2. The ask flow. With no name saved the desktop asks nicely, and typing a
 *    name has to reach settings and turn into a greeting in place.
 *
 * Also saves .shots/hello-*.png so the hello can be looked at, not just
 * asserted about.
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
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

  async function shot(name) {
    const image = await win.webContents.capturePage()
    const file = path.join(projectRoot, '.shots', `${name}.png`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, image.toPNG())
    console.log(`  📸 ${file}`)
  }

  // --- no name saved: the desktop asks, nicely ---
  await win.loadFile(path.join(projectRoot, 'src/renderer/index.html'), {
    query: { owner: '' },
  })
  await wait(900)

  const ask = await js(`(() => {
    const el = document.getElementById('hello')
    if (!el) return null
    return {
      ask: el.classList.contains('ask'),
      title: el.querySelector('.hello-title')?.textContent ?? '',
      hasInput: Boolean(el.querySelector('.hello-input')),
      hasLater: Boolean(el.querySelector('.hello-later')),
      focusStolen: document.activeElement !== document.body,
    }
  })()`)
  check('with no name saved, a hello card appears', Boolean(ask), JSON.stringify(ask))
  check('it asks for a name rather than guessing', ask?.ask === true && ask.hasInput === true, JSON.stringify(ask))
  check('it welcomes before it asks', /welcome/i.test(ask?.title ?? ''), ask?.title)
  check('declining is offered, not just submit', ask?.hasLater === true)
  check('the card does not steal the keyboard', ask?.focusStolen === false, `activeElement moved=${ask?.focusStolen}`)

  await shot('hello-ask')

  // --- non-blocking: the desktop underneath stays fully usable ---
  const dockPoint = await centreOf('.dock-app')
  check('the dock is reachable while the card is up', Boolean(dockPoint))
  if (dockPoint) await clickAt(dockPoint)
  await wait(500)

  const openedUnder = await js(`document.querySelectorAll('.window').length`)
  check('clicking a dock app still opens its window', openedUnder === 1, `windows=${openedUnder}`)

  // --- the greeting is scenery, not chrome: a window paints over it ---
  // pointer-events: none makes elementFromPoint blind to paint order, so
  // this is measured from the pixels: park the window squarely over the
  // card (its stage is opaque white — the stub launches about:blank), then
  // hide the card. If the window is on top, nothing changes. If the card
  // was painting over the window, its text shadows vanish from the image.
  const helloRect = await js(`(() => {
    const r = document.getElementById('hello').getBoundingClientRect()
    const w = document.querySelector('.window')
    w.style.left = Math.round(r.x - 60) + 'px'
    w.style.top = Math.round(r.y - 70) + 'px'
    w.style.width = Math.round(r.width + 120) + 'px'
    w.style.height = Math.round(r.height + 140) + 'px'
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  await wait(400)
  await shot('hello-under-window')
  const overWindow = (await win.webContents.capturePage(helloRect)).toBitmap()
  await js(`document.getElementById('hello').style.visibility = 'hidden'`)
  await wait(300)
  const noHello = (await win.webContents.capturePage(helloRect)).toBitmap()
  await js(`document.getElementById('hello').style.visibility = ''`)
  let changed = 0
  for (let i = 0; i < overWindow.length; i += 1) {
    if (Math.abs(overWindow[i] - noHello[i]) > 8) changed += 1
  }
  const changedRatio = changed / overWindow.length
  check(
    'an open window paints over the greeting',
    changedRatio < 0.001,
    `${(changedRatio * 100).toFixed(2)}% of the covered region changed when the card was hidden`,
  )

  // Close it again so the rest of the flow runs on a clean desktop.
  const closePoint = await centreOf('.window .titlebar button.close')
  if (closePoint) await clickAt(closePoint)

  // --- typing a name turns the ask into a greeting ---
  const inputPoint = await centreOf('.hello-input')
  check('the name field is clickable', Boolean(inputPoint))
  if (inputPoint) await clickAt(inputPoint)

  for (const ch of 'Etienne') {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await wait(20)
  }

  const typed = await js(`document.querySelector('.hello-input')?.value`)
  check('real keystrokes land in the field', typed === 'Etienne', `value=${JSON.stringify(typed)}`)

  const savePoint = await centreOf('.hello-save')
  if (savePoint) await clickAt(savePoint)
  await wait(400)

  const savedName = await js(`window.reef.__savedSettings()`)
  check(
    'submitting saves the name in settings',
    savedName?.ownerName === 'Etienne',
    JSON.stringify(savedName),
  )

  const met = await js(`(() => {
    const el = document.getElementById('hello')
    if (!el) return null
    return {
      ask: el.classList.contains('ask'),
      title: el.querySelector('.hello-title')?.textContent ?? '',
      inputGone: !el.querySelector('.hello-input'),
    }
  })()`)
  check(
    'the card becomes a greeting in place',
    met?.ask === false && met.inputGone === true && met.title.includes('Etienne'),
    JSON.stringify(met),
  )

  await shot('hello-greet')

  // --- a saved name: greeted by name, and nothing is hittable ---
  await win.loadFile(path.join(projectRoot, 'src/renderer/index.html'), {
    query: { owner: 'Ariel' },
  })
  await wait(900)

  const greet = await js(`(() => {
    const el = document.getElementById('hello')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const centre = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      ask: el.classList.contains('ask'),
      title: el.querySelector('.hello-title')?.textContent ?? '',
      pointerEvents: getComputedStyle(el).pointerEvents,
      // The true non-blocking proof: a click aimed at the greeting's centre
      // would land on whatever is underneath it.
      hitTestPassesThrough: !el.contains(centre),
    }
  })()`)
  check('a saved name is greeted by name', Boolean(greet) && greet.title.includes('Ariel'), JSON.stringify(greet))
  check('the greeting asks nothing', greet?.ask === false, JSON.stringify(greet))
  check(
    'the greeting cannot intercept a single click',
    greet?.pointerEvents === 'none' && greet.hitTestPassesThrough === true,
    JSON.stringify(greet),
  )

  // --- it leaves on its own ---
  await wait(8600)
  const lingering = await js(`(() => {
    const el = document.getElementById('hello')
    return el ? { leaving: el.classList.contains('leaving') } : { gone: true }
  })()`)
  check(
    'the greeting fades out by itself',
    lingering?.gone === true || lingering?.leaving === true,
    JSON.stringify(lingering),
  )

  // --- "maybe later" declines without saving ---
  await win.loadFile(path.join(projectRoot, 'src/renderer/index.html'), {
    query: { owner: '' },
  })
  await wait(900)

  const laterPoint = await centreOf('.hello-later')
  check('maybe later is present again on a fresh start', Boolean(laterPoint))
  if (laterPoint) await clickAt(laterPoint)
  await wait(1100)

  const declined = await js(`(() => ({
    gone: !document.getElementById('hello') || document.getElementById('hello').classList.contains('leaving'),
    saved: window.reef.__savedSettings(),
  }))()`)
  check('declining dismisses the card', declined?.gone === true, JSON.stringify(declined))
  check('declining saves nothing', declined?.saved === null, JSON.stringify(declined?.saved))

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
