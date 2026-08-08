/**
 * The edit chat pane, driven by real Chromium input events.
 *
 *   npm run test:electron:ui   (runs window-controls first, then this)
 *
 * What only a real page can prove: that the edit affordance exists for a
 * reef-built app and *does not exist* for anything else, that opening the pane
 * leaves the app's stage usable rather than crushed, and that the pointer
 * still drags a titlebar carrying the extra button. Assertions measure
 * bounding boxes — the effect on screen — never classList.
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
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

  const js = (code) =>
    win.webContents.executeJavaScript(code).catch((err) => ({ __error: String(err.message ?? err) }))

  const centreOf = (selector) =>
    js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

  async function clickAt({ x, y }) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await wait(40)
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await wait(260)
  }

  // --- a non-generated app gets no edit affordance ---
  // The stub's first app ("probe") is not reef-built.
  const probeIcon = await centreOf('#dock-apps .dock-app:nth-of-type(1)')
  check('the probe app is in the dock', Boolean(probeIcon))
  if (probeIcon) await clickAt(probeIcon)

  const probeEdit = await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return { window: false }
    return { window: true, editButtons: w.querySelectorAll('.titlebar button.edit').length }
  })()`)
  check(
    'an app built outside reef has no Edit button',
    probeEdit.window === true && probeEdit.editButtons === 0,
    JSON.stringify(probeEdit),
  )

  const probeClose = await centreOf('.window .titlebar button.close')
  if (probeClose) await clickAt(probeClose)

  // --- the generated app carries the affordance ---
  // "doodle" is the stub's ⌘K-built app, third in the dock.
  const doodleIcon = await centreOf('#dock-apps .dock-app:nth-of-type(3)')
  check('the generated app is in the dock', Boolean(doodleIcon))
  if (doodleIcon) await clickAt(doodleIcon)

  const editBox = await js(`(() => {
    const el = document.querySelector('.window .titlebar button.edit')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  check(
    'a reef-built app has a visible Edit button',
    Boolean(editBox) && editBox.w > 0 && editBox.h > 0,
    JSON.stringify(editBox),
  )

  // --- opening the pane: chat visible, stage intact, window wider ---
  const widthBefore = await js(`document.querySelector('.window')?.getBoundingClientRect().width`)
  const editPoint = await centreOf('.window .titlebar button.edit')
  if (editPoint) await clickAt(editPoint)

  const paneOpen = await js(`(() => {
    const w = document.querySelector('.window')
    const chat = w?.querySelector('.chat')
    const stage = w?.querySelector('.stage')
    if (!w || !chat || !stage) return null
    return {
      window: Math.round(w.getBoundingClientRect().width),
      chat: Math.round(chat.getBoundingClientRect().width),
      stage: Math.round(stage.getBoundingClientRect().width),
      input: Boolean(chat.querySelector('.chat-input')),
    }
  })()`)
  check('clicking Edit opens the chat pane', Boolean(paneOpen), JSON.stringify(paneOpen))
  check(
    'the chat pane has real width',
    paneOpen && paneOpen.chat >= 300,
    `chat=${paneOpen?.chat}`,
  )
  check(
    'the app stage is not crushed by the pane',
    paneOpen && paneOpen.stage >= 320,
    `stage=${paneOpen?.stage}`,
  )
  check(
    'the window grew instead of squeezing the app',
    paneOpen && widthBefore && paneOpen.window > widthBefore,
    `${widthBefore} -> ${paneOpen?.window}`,
  )

  // --- a message round-trips through the stubbed bridge ---
  await js(`(() => {
    const input = document.querySelector('.chat-input')
    input.value = 'make the header bigger'
    return true
  })()`)
  const sendPoint = await centreOf('.chat-send')
  check('the send button is clickable', Boolean(sendPoint))
  if (sendPoint) await clickAt(sendPoint)
  await wait(300)

  const thread = await js(`(() => {
    const log = document.querySelector('.chat-log')
    if (!log) return null
    return {
      user: log.querySelector('.msg.user')?.textContent ?? null,
      assistant: log.querySelector('.msg.assistant')?.textContent ?? null,
      progressGone: log.querySelectorAll('.chat-progress').length === 0,
      inputEnabled: !document.querySelector('.chat-input').disabled,
    }
  })()`)
  check(
    'the sent message appears as a user bubble',
    thread?.user === 'make the header bigger',
    JSON.stringify(thread),
  )
  check(
    "the stub's reply appears as an assistant bubble",
    thread?.assistant === 'Done.',
    JSON.stringify(thread),
  )
  check('the progress line is cleared after the turn', thread?.progressGone === true)
  check('the input is usable for the next turn', thread?.inputEnabled === true)

  // --- dragging still works with the extra button in the titlebar ---
  const before = await js(
    `(() => { const w = document.querySelector('.window'); return { left: w.offsetLeft, top: w.offsetTop } })()`,
  )
  const titlePoint = await centreOf('.window .titlebar .name')
  if (titlePoint) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: titlePoint.x, y: titlePoint.y, button: 'left', clickCount: 1 })
    await wait(60)
    for (let step = 1; step <= 5; step += 1) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: titlePoint.x + step * 16,
        y: titlePoint.y + step * 10,
        button: 'left',
        movementX: 16,
        movementY: 10,
      })
      await wait(30)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: titlePoint.x + 80, y: titlePoint.y + 50, button: 'left', clickCount: 1 })
    await wait(220)
  }
  const after = await js(
    `(() => { const w = document.querySelector('.window'); return w ? { left: w.offsetLeft, top: w.offsetTop } : null })()`,
  )
  check(
    'the titlebar still drags with the Edit button present',
    Boolean(after) && (after.left !== before.left || after.top !== before.top),
    `${before.left},${before.top} -> ${after ? `${after.left},${after.top}` : 'gone'}`,
  )

  // The drag pushed a 1066px-wide window right; its chat column can now hang
  // past the harness viewport, where a synthetic click lands on nothing. Put
  // it back at a known position so the close control is genuinely on screen.
  await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return false
    w.style.left = '60px'
    w.style.top = '70px'
    return true
  })()`)
  await wait(80)

  // --- closing the pane returns the window to a plain app window ---
  const paneClosePoint = await centreOf('.chat-close')
  check('the pane close control is clickable', Boolean(paneClosePoint))
  if (paneClosePoint) await clickAt(paneClosePoint)

  const closed = await js(`(() => {
    const w = document.querySelector('.window')
    return {
      chats: w?.querySelectorAll('.chat').length ?? null,
      width: Math.round(w?.getBoundingClientRect().width ?? 0),
    }
  })()`)
  check('closing the pane removes the chat', closed?.chats === 0, JSON.stringify(closed))
  check(
    'closing the pane narrows the window back down',
    closed && paneOpen && closed.width < paneOpen.window,
    `${paneOpen?.window} -> ${closed?.width}`,
  )

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
