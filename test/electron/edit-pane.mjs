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

  // --- a linked app gets no edit affordance ---
  // The stub's first app ("probe") is a linked project: someone's checkout.
  const probeIcon = await centreOf('#dock-apps .dock-app:nth-of-type(1)')
  check('the probe app is in the dock', Boolean(probeIcon))
  if (probeIcon) await clickAt(probeIcon)

  const probeEdit = await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return { window: false }
    return { window: true, editButtons: w.querySelectorAll('.titlebar button.edit').length }
  })()`)
  check(
    'a linked app has no Edit button',
    probeEdit.window === true && probeEdit.editButtons === 0,
    JSON.stringify(probeEdit),
  )

  const probeClose = await centreOf('.window .titlebar button.close')
  if (probeClose) await clickAt(probeClose)

  // --- a bundled sample carries it (editable by adoption) ---
  // "feed-reader" is the stub's bundled sample, second in the dock.
  const sampleIcon = await centreOf('#dock-apps .dock-app:nth-of-type(2)')
  check('the bundled sample is in the dock', Boolean(sampleIcon))
  if (sampleIcon) await clickAt(sampleIcon)

  const sampleEdit = await js(`(() => {
    const el = document.querySelector('.window .titlebar button.edit')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  check(
    'a bundled sample has a visible Edit button',
    Boolean(sampleEdit) && sampleEdit.w > 0 && sampleEdit.h > 0,
    JSON.stringify(sampleEdit),
  )

  const sampleClose = await centreOf('.window .titlebar button.close')
  if (sampleClose) await clickAt(sampleClose)

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

  // Close and minimize lean on the traffic-light convention; a blue "edit"
  // bubble has no convention carrying it, so its ✎ must be legible without
  // hovering. The pointer is over the dock here, so this is the at-rest state.
  const glyphAtRest = await js(`(() => {
    const el = document.querySelector('.window .titlebar button.edit')
    if (!el) return null
    return { color: getComputedStyle(el).color, glyph: el.textContent }
  })()`)
  check(
    'the ✎ is visible at rest, not only on hover',
    glyphAtRest?.glyph === '✎' && !/transparent|rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(glyphAtRest?.color ?? ''),
    JSON.stringify(glyphAtRest),
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

  // The chat is glass: its own paint must be translucent AND nothing behind
  // it may paint an opaque surface, or the "transparency" is a solid colour
  // with extra steps. Assert both layers, then photograph the real thing.
  const glass = await js(`(() => {
    const w = document.querySelector('.window')
    const chat = w?.querySelector('.chat')
    if (!chat) return null
    const alphaOf = (c) => {
      const m = c.match(/rgba?\\(\\s*\\d+,\\s*\\d+,\\s*\\d+(?:,\\s*([\\d.]+))?\\)/)
      return m ? (m[1] === undefined ? 1 : Number(m[1])) : 1
    }
    return {
      chatAlpha: alphaOf(getComputedStyle(chat).backgroundColor),
      windowAlpha: alphaOf(getComputedStyle(w).backgroundColor),
      blurred: getComputedStyle(chat).backdropFilter.includes('blur'),
    }
  })()`)
  check(
    'the reef shows through the chat pane',
    glass && glass.chatAlpha < 1 && glass.windowAlpha === 0 && glass.blurred === true,
    JSON.stringify(glass),
  )

  await fs.mkdir(path.join(projectRoot, '.shots'), { recursive: true })
  const shot = await win.webContents.capturePage()
  await fs.writeFile(path.join(projectRoot, '.shots', 'edit-pane-glass.png'), shot.toPNG())

  // --- while the turn runs, the progress line bubbles and narrates ---
  // A real turn takes minutes; a bare static "Thinking…" reads as stuck. The
  // live line must carry the same bubbling animation as the palette and the
  // dock tile, and must move with the agent's actual activity.
  await js(`window.reef.__holdEdits()`)
  await js(`(() => {
    const input = document.querySelector('.chat-input')
    input.value = 'make the header bigger'
    return true
  })()`)
  const sendPoint = await centreOf('.chat-send')
  check('the send button is clickable', Boolean(sendPoint))
  if (sendPoint) await clickAt(sendPoint)
  await wait(300)

  const inFlight = await js(`(() => {
    const line = document.querySelector('.chat-log .chat-progress')
    if (!line) return null
    const bubbles = line.querySelectorAll('.bubbles i')
    const box = line.querySelector('.bubbles')?.getBoundingClientRect()
    return {
      bubbles: bubbles.length,
      bubblesVisible: Boolean(box) && box.width > 0 && box.height > 0,
      text: line.querySelector('.status-text')?.textContent ?? null,
      animated: bubbles.length ? getComputedStyle(bubbles[0]).animationName !== 'none' : false,
    }
  })()`)
  check(
    'the in-flight progress line carries bubbles',
    inFlight?.bubbles === 3 && inFlight.bubblesVisible === true,
    JSON.stringify(inFlight),
  )
  check('the bubbles actually animate', inFlight?.animated === true, JSON.stringify(inFlight))
  check(
    'the line opens on reading the app',
    inFlight?.text === 'Reading the app…',
    JSON.stringify(inFlight),
  )

  // Progress events move the text — the palette's tool vocabulary, per phase.
  const narrated = await js(`(async () => {
    const textOf = () =>
      document.querySelector('.chat-log .chat-progress .status-text')?.textContent ?? null
    window.reef.__emitEditing({ id: 'doodle', phase: 'thinking', tool: 'read_file' })
    const thinking = textOf()
    window.reef.__emitEditing({ id: 'doodle', phase: 'writing', file: 'index.html' })
    const writing = textOf()
    return { thinking, writing }
  })()`)
  check(
    "a 'thinking' event narrates the tool in play",
    narrated?.thinking === 'Reading it back…',
    JSON.stringify(narrated),
  )
  check(
    "a 'writing' event names the file",
    narrated?.writing === 'Rewriting index.html…',
    JSON.stringify(narrated),
  )

  const midFlight = await win.webContents.capturePage()
  await fs.writeFile(path.join(projectRoot, '.shots', 'edit-pane-progress.png'), midFlight.toPNG())

  // --- a message round-trips through the stubbed bridge ---
  await js(`window.reef.__releaseEdits()`)
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

  // --- a change on disk re-navigates the open frame ---
  // main announces edits (watcher hits, server-edit restarts) on apps:changed;
  // the user-visible effect is the frame loading again. This was shipped
  // broken once: openApp stored a spread copy of the window in openWindows,
  // so the frame assigned after launch never reached the object onChanged
  // reads, and the reload silently did nothing for every app.
  const reload = await js(`(async () => {
    const f = document.querySelector('.window iframe')
    if (!f) return { frame: false }
    let loads = 0
    f.addEventListener('load', () => { loads += 1 })
    window.reef.__emitChanged({ id: 'doodle' })
    await new Promise((r) => setTimeout(r, 400))
    return { frame: true, loads }
  })()`)
  check(
    'a files-changed event re-navigates the app frame',
    reload.frame === true && reload.loads >= 1,
    JSON.stringify(reload),
  )

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

  // --- the conversation survives the pane being toggled ---
  // The history lives in main; the pane is only a view of it. Reopening the
  // pane must rebuild the log, not start a blank one.
  const editReopenPoint = await centreOf('.window .titlebar button.edit')
  if (editReopenPoint) await clickAt(editReopenPoint)
  await wait(200)

  const rebuilt = await js(`(() => {
    const log = document.querySelector('.chat-log')
    if (!log) return null
    return {
      user: log.querySelector('.msg.user')?.textContent ?? null,
      assistant: log.querySelector('.msg.assistant')?.textContent ?? null,
    }
  })()`)
  check(
    'reopening the pane rebuilds the conversation from main',
    rebuilt?.user === 'make the header bigger' && rebuilt?.assistant === 'Done.',
    JSON.stringify(rebuilt),
  )

  // --- closing the window mid-turn, then reopening it ---
  // The agent keeps coding after its window closes. A reopened window must
  // come back mid-sentence: pane open, history rendered, live line ticking.
  await js(`window.reef.__holdEdits()`)
  await js(`(() => {
    const input = document.querySelector('.chat-input')
    input.value = 'now the footer'
    return true
  })()`)
  const send2 = await centreOf('.chat-send')
  if (send2) await clickAt(send2)
  await wait(200)
  await js(`window.reef.__emitEditing({ id: 'doodle', phase: 'thinking', tool: 'read_file' })`)

  const closeMidTurn = await centreOf('.window .titlebar button.close')
  if (closeMidTurn) await clickAt(closeMidTurn)
  const windowGone = await js(`document.querySelectorAll('.window').length`)
  check('the window closes while the turn is running', windowGone === 0)

  const doodleAgain = await centreOf('#dock-apps .dock-app:nth-of-type(3)')
  if (doodleAgain) await clickAt(doodleAgain)
  await wait(500)

  const resumed = await js(`(() => {
    const w = document.querySelector('.window')
    const chat = w?.querySelector('.chat')
    if (!w) return null
    if (!chat) return { pane: false }
    const log = chat.querySelector('.chat-log')
    const line = log?.querySelector('.chat-progress')
    const box = line?.querySelector('.bubbles')?.getBoundingClientRect()
    return {
      pane: true,
      users: [...log.querySelectorAll('.msg.user')].map((el) => el.textContent),
      assistants: [...log.querySelectorAll('.msg.assistant')].map((el) => el.textContent),
      progressText: line?.querySelector('.status-text')?.textContent ?? null,
      bubblesVisible: Boolean(box) && box.width > 0 && box.height > 0,
      inputDisabled: chat.querySelector('.chat-input')?.disabled ?? null,
    }
  })()`)
  check('the reopened window brings the pane back by itself', resumed?.pane === true, JSON.stringify(resumed))
  check(
    'the rebuilt log carries the whole conversation, in-flight turn included',
    resumed?.users?.length === 2 && resumed.users[1] === 'now the footer' && resumed.assistants?.length === 1,
    JSON.stringify(resumed),
  )
  check(
    'the live line resumes from the last progress event, bubbling',
    resumed?.progressText === 'Reading it back…' && resumed.bubblesVisible === true,
    JSON.stringify(resumed),
  )
  check('the input stays held while the turn runs', resumed?.inputDisabled === true, JSON.stringify(resumed))

  const resumedShot = await win.webContents.capturePage()
  await fs.writeFile(path.join(projectRoot, '.shots', 'edit-pane-resumed.png'), resumedShot.toPNG())

  // The turn finishing lands in the rebuilt pane, not the dead one it started in.
  await js(`window.reef.__releaseEdits()`)
  await wait(300)
  const landed = await js(`(() => {
    const chat = document.querySelector('.window .chat')
    if (!chat) return null
    return {
      assistants: chat.querySelectorAll('.msg.assistant').length,
      progressGone: chat.querySelectorAll('.chat-progress').length === 0,
      inputEnabled: !chat.querySelector('.chat-input').disabled,
    }
  })()`)
  check(
    "the finished turn's reply lands in the reopened pane",
    landed?.assistants === 2 && landed.progressGone === true && landed.inputEnabled === true,
    JSON.stringify(landed),
  )

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
