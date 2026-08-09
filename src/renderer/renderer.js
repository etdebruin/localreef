/**
 * The desktop canvas.
 *
 * Owns icon layout and window management. Apps live in iframes on their own
 * origin, which means the parent cannot see inside them — that shapes two of
 * the behaviours here: a pointer shield during drags, and an explicit focus
 * click-catcher, since a click landing inside an iframe never reaches us.
 */

import { greetingFor } from '../core/greeting.js'

const dockAppsEl = document.getElementById('dock-apps')
const emptyEl = document.getElementById('empty')
const windowsEl = document.getElementById('windows')
const shieldEl = document.getElementById('shield')
const refreshEl = document.getElementById('refresh')

/** id -> { el, body, stage, app, minimized, frame?, url?, chat? } */
const openWindows = new Map()

/** id -> dock button, so run state can be updated without a full re-render. */
const dockButtons = new Map()
let topZ = 10
let cascade = 0

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props)
  for (const child of children.flat()) {
    if (child != null) el.append(child)
  }
  return el
}

/**
 * Build an app's square tile.
 *
 * Geometry never varies — same square, same corner, same shadow — so a dock of
 * mixed apps reads as one set. Only the contents change: supplied art, a
 * supplied emoji, or a tile tinted from the app's id. Main decides which;
 * this only draws it.
 */
function tileFor(app, className = 'tile') {
  const tile = app.tile ?? { kind: 'generated', initials: '?', hue: 0 }
  const el = h('span', { className: `${className} ${className}--${tile.kind}` })

  if (tile.kind === 'image') {
    el.append(h('img', { src: tile.image, alt: '', draggable: false }))
    return el
  }

  if (tile.kind === 'emoji') {
    el.style.setProperty('--hue', String(tile.hue ?? 0))
    el.append(h('span', { className: 'tile-glyph', textContent: tile.glyph }))
    return el
  }

  // Hue only. Lightness and chroma are fixed in CSS so every generated tile
  // carries the same visual weight and the set looks deliberate.
  el.style.setProperty('--hue', String(tile.hue))
  el.append(h('span', { className: 'tile-initials', textContent: tile.initials }))
  return el
}

// ----------------------------------------------------------------- dock

/**
 * The dock is the only launcher — the canvas is window space, nothing else.
 * Tiling every app across the desktop turned a screenful of emoji into
 * something that read like a channel list; one row at the bottom keeps the
 * icons small, in a fixed place, and out of the way of the windows.
 */
/**
 * id -> { el, prompt, status, lines } — ⌘K builds still in flight.
 *
 * Each one is a bubbling placeholder at the end of the dock: the build is
 * real desktop state the user can walk away from and come back to, so it
 * lives here with the dock, not inside the palette that started it.
 */
const pendingBuilds = new Map()

function trackBuild(id, prompt) {
  const build = {
    prompt,
    status: 'Designing the app…',
    lines: [],
    el: h(
      'button',
      { className: 'dock-app building', title: 'Designing the app…' },
      h(
        'span',
        { className: 'tile tile--building' },
        h('span', { className: 'tile-bubbles' }, h('i'), h('i'), h('i')),
      ),
      h('span', { className: 'dot' }),
    ),
  }

  // The bubbles answer "is it still going?"; a click answers "what is it
  // doing?" — it reopens the palette on this build's live feed.
  build.el.addEventListener('click', () => watchBuild(id))
  pendingBuilds.set(id, build)
  dockAppsEl.append(build.el)
  emptyEl.hidden = true
  return build
}

async function renderDock() {
  const apps = await window.reef.listApps()
  dockAppsEl.replaceChildren()
  dockButtons.clear()

  emptyEl.hidden = apps.length > 0 || pendingBuilds.size > 0

  for (const app of apps) {
    const button = h(
      'button',
      {
        className: `dock-app${app.status === 'broken' ? ' broken' : ''}`,
        // No visible label — the dock stays compact and the name lives in the
        // tooltip, the way a macOS dock does it.
        title: app.error ? `${app.name} — ${app.error}` : app.name,
      },
      tileFor(app),
      h('span', { className: 'dot' }),
    )

    button.addEventListener('click', () => activate(app))
    dockButtons.set(app.id, button)
    dockAppsEl.append(button)
  }

  // Builds in flight keep their place through any dock rebuild.
  for (const build of pendingBuilds.values()) dockAppsEl.append(build.el)

  syncDock()
}

/** Click behaviour depends on what the app is already doing. */
function activate(app) {
  const win = openWindows.get(app.id)
  if (!win) return openApp(app)
  if (win.minimized) return restoreWindow(app.id)
  focusWindow(app.id)
}

/** Reflect run state in the dock without rebuilding it. */
function syncDock() {
  for (const [id, el] of dockButtons) {
    const win = openWindows.get(id)
    el.classList.toggle('running', Boolean(win))
    el.classList.toggle('minimized', Boolean(win?.minimized))
  }
}

// -------------------------------------------------------------- session

/**
 * Keep the on-disk session matching the screen.
 *
 * Everything that moves a window funnels through here: open, close, minimize,
 * restore, focus, and the end of every drag or resize. Debounced because a
 * drag emits geometry continuously, and the arrangement only needs to be
 * durable, not live. The array order is the z-order, bottom to top, so
 * restoring by opening in order reproduces the stacking.
 */
let persistTimer = null

function persistSession() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const windows = [...openWindows.entries()]
      .sort((a, b) => Number(a[1].el.style.zIndex) - Number(b[1].el.style.zIndex))
      .map(([id, win]) => ({
        id,
        // From the inline styles, not offset*: a minimized window is
        // display:none, where every offset reads 0 — recording that would
        // wipe its real geometry the moment it was parked.
        left: parseInt(win.el.style.left, 10),
        top: parseInt(win.el.style.top, 10),
        width: parseInt(win.el.style.width, 10),
        height: parseInt(win.el.style.height, 10),
        minimized: win.minimized,
        maximized: Boolean(win.maximized),
      }))
    window.reef.saveSession(windows)
  }, 300)
}

/** Reopen everything the last session had on screen, where it had it. */
async function restoreSession() {
  const [session, apps] = await Promise.all([window.reef.getSession(), window.reef.listApps()])
  const byId = new Map(apps.map((a) => [a.id, a]))

  let front = null
  for (const saved of session?.windows ?? []) {
    const app = byId.get(saved.id)
    if (!app || app.status === 'broken' || openWindows.has(saved.id)) continue

    // Not awaited: window creation is synchronous, so stacking order is
    // already right, and one slow server must not hold up the rest.
    openApp(app, saved)
    if (saved.minimized) minimizeWindow(saved.id)
    else front = saved.id
  }

  // Opening a minimized window last would otherwise leave nothing marked
  // focused — every visible window looking inactive is the bug the focus
  // model exists to prevent.
  if (front) focusWindow(front)
}

// -------------------------------------------------------------- windows

/**
 * Raise a window and mark it focused.
 *
 * z-order alone was the whole focus model, which meant nothing on screen said
 * which window your keystrokes were going to. The class drives the chrome:
 * unfocused windows lose their shadow depth, their title dims, and the
 * traffic-light dots drain of colour.
 */
function focusWindow(id) {
  const win = openWindows.get(id)
  if (!win) return

  win.el.style.zIndex = String(++topZ)
  for (const [otherId, other] of openWindows) {
    other.el.classList.toggle('focused', otherId === id)
  }
  persistSession()
}

/**
 * Full screen, and back.
 *
 * Class-only: `.maximized` fills the canvas through CSS, so the inline
 * left/top/width/height are never touched and un-maximizing is just dropping
 * the class — the window returns to exactly where it was, no geometry to save
 * and restore. Raise it first, because a maximized window that is not on top
 * is a confusing full-canvas nothing.
 */
function toggleMaximize(id) {
  const win = openWindows.get(id)
  if (!win) return
  focusWindow(id)
  win.maximized = !win.el.classList.contains('maximized')
  win.el.classList.toggle('maximized', win.maximized)
  persistSession()
}

function closeWindow(id) {
  const win = openWindows.get(id)
  if (!win) return
  win.el.remove()
  openWindows.delete(id)
  // Every close tells main, static apps included: stop is the teardown hook
  // for anything scoped to "this app is open" — the process for a server app,
  // and the folder watcher and edit conversation for everything.
  window.reef.stop(id)

  // Hand focus to whatever is now highest, so closing the front window does
  // not leave every remaining one looking inactive.
  const next = [...openWindows.entries()]
    .filter(([, other]) => !other.minimized)
    .sort((a, b) => Number(a[1].el.style.zIndex) - Number(b[1].el.style.zIndex))
    .pop()
  if (next) focusWindow(next[0])

  syncDock()
  persistSession()
}

/**
 * Minimize hides the window; it does not stop the app.
 *
 * The iframe has to stay in the DOM — removing it would tear down the app's
 * page and lose whatever state it holds, which is the opposite of what
 * minimizing means. `hidden` keeps it alive and off screen.
 */
function minimizeWindow(id) {
  const win = openWindows.get(id)
  if (!win || win.minimized) return
  win.minimized = true
  win.el.hidden = true
  win.el.classList.remove('focused')
  syncDock()
  persistSession()
}

function restoreWindow(id) {
  const win = openWindows.get(id)
  if (!win) return
  win.minimized = false
  win.el.hidden = false
  focusWindow(id)
  syncDock()
  persistSession()
}

/** `at` is a saved geometry from a previous session; without it, cascade. */
function makeWindow(app, at) {
  const offset = (cascade++ % 6) * 28

  // The stage holds whatever the window shows — spinner, crash panel, or the
  // app's iframe. It exists so those can be swapped without touching anything
  // else living in the body, like the edit chat.
  const stage = h('div', { className: 'stage' })
  const body = h('div', { className: 'body' }, stage)
  const titlebar = h(
    'div',
    { className: 'titlebar' },
    tileFor(app, 'tile-sm'),
    h('span', { className: 'name', textContent: app.name }),
    h('span', { className: 'spacer' }),
  )

  // Only reef-built apps carry the edit chat: everything else on the desktop
  // is somebody's real checkout, and main refuses to edit those anyway.
  if (app.generated) {
    const edit = h('button', { className: 'edit', title: 'Edit with AI', textContent: '✎' })
    edit.addEventListener('click', () => toggleEditPane(app.id))
    titlebar.append(edit)
  }

  const expand = h('button', { className: 'expand', title: 'Full screen', textContent: '⤢' })
  expand.addEventListener('click', () => toggleMaximize(app.id))

  const minimize = h('button', { className: 'minimize', title: 'Minimize', textContent: '–' })
  minimize.addEventListener('click', () => minimizeWindow(app.id))

  // × quits the app, not just the window: for a server app it stops the
  // process. Minimize is the way to put it away and keep it running.
  const close = h('button', { className: 'close', title: 'Quit', textContent: '×' })
  close.addEventListener('click', () => closeWindow(app.id))

  titlebar.append(expand, minimize, close)

  // The other way to full screen, the way every OS trained people to reach
  // for. Not a `dblclick` listener: the drag handler below calls
  // preventDefault on pointerdown, which suppresses the browser's synthesized
  // dblclick outright. So detect it ourselves from two quick pointerdowns on
  // the titlebar (never on its controls). event.timeStamp, not a clock.
  let lastTitlebarDown = 0
  titlebar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, a, input, select, textarea')) return
    if (event.timeStamp - lastTitlebarDown < 350) {
      toggleMaximize(app.id)
      lastTitlebarDown = 0
      return
    }
    lastTitlebarDown = event.timeStamp
  })

  // A click that lands inside an app's iframe dies in the frame's document and
  // never reaches this window — so a back window could not be raised by
  // clicking its content, only its titlebar. This transparent layer sits over
  // the frame *only while the window is unfocused* (CSS), catches that first
  // click in the parent document, and focuses the window; once focused it is
  // display:none, handing the pointer straight back to the app.
  const catcher = h('div', { className: 'catcher' })
  catcher.addEventListener('mousedown', () => focusWindow(app.id))

  const resize = h('div', { className: 'resize' })
  const el = h('div', { className: 'window' }, titlebar, body, catcher, resize)

  // Clamped the same way a drag is, so a session saved on a bigger screen
  // still leaves every titlebar reachable.
  el.style.left = `${Math.max(0, at?.left ?? 90 + offset)}px`
  el.style.top = `${Math.max(34, at?.top ?? 70 + offset)}px`
  el.style.width = `${Math.max(320, at?.width ?? 820)}px`
  el.style.height = `${Math.max(200, at?.height ?? 560)}px`
  el.style.zIndex = String(++topZ)

  el.addEventListener('mousedown', () => focusWindow(app.id), true)

  dragWith(titlebar, (dx, dy, start) => {
    el.style.left = `${Math.max(0, start.left + dx)}px`
    el.style.top = `${Math.max(34, start.top + dy)}px`
  }, () => ({ left: el.offsetLeft, top: el.offsetTop }))

  dragWith(resize, (dx, dy, start) => {
    el.style.width = `${Math.max(320, start.width + dx)}px`
    el.style.height = `${Math.max(200, start.height + dy)}px`
  }, () => ({ width: el.offsetWidth, height: el.offsetHeight }))

  windowsEl.append(el)
  return { el, body, stage }
}

/**
 * Pointer drag with a full-canvas shield. Without the shield the pointer
 * stream is captured by whatever iframe the cursor passes over and the drag
 * stalls mid-gesture.
 */
function dragWith(handle, onMove, getStart) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return

    // Never start a drag from a control living inside the handle. The close
    // button sits in the titlebar, and capturing the pointer here would route
    // pointerup to the titlebar instead of the button — so the button never
    // completes a click and the X does nothing.
    if (event.target.closest('button, a, input, select, textarea')) return

    event.preventDefault()

    const origin = { x: event.clientX, y: event.clientY }
    const start = getStart()
    shieldEl.hidden = false

    // Window-level listeners rather than pointer capture. Capturing on the
    // handle proved unreliable here — it silently failed to bind, so drags
    // stopped working entirely. The shield below already stops iframes
    // swallowing the pointer, and the blur handler covers a release that
    // happens outside the window.
    const move = (e) => onMove(e.clientX - origin.x, e.clientY - origin.y, start)
    const end = () => {
      shieldEl.hidden = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      // The gesture settled somewhere; make that somewhere durable.
      persistSession()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  })
}

// Last-resort safety: if focus leaves entirely mid-gesture, never strand the
// shield over the desktop.
window.addEventListener('blur', () => {
  shieldEl.hidden = true
})

function showState(body, ...children) {
  body.replaceChildren(h('div', { className: 'state' }, ...children))
}

// ------------------------------------------------------------- fix with AI

const homeShort = (p) => (p ?? '').replace(/^\/Users\/[^/]+/, '~')

/**
 * Repair affordance for a failed app.
 *
 * Always names the folder it will edit. A linked app's folder is the user's
 * real project checkout, so that case takes an explicit second click rather
 * than rewriting someone's repository on a single misclick.
 */
function fixPanel(win, app, onDone) {
  const wrap = h('div', { className: 'fix-wrap' })
  const button = h('button', { className: 'fix', textContent: '✨ Fix with AI' })
  const note = h('div', {
    className: 'fix-note',
    textContent: app.dir ? `edits ${homeShort(app.dir)}` : '',
  })

  // Discovered apps are found in the user's projects folder, so they are as
  // much a real checkout as a linked one — both take the second click.
  let armed = !(app.linked || app.discovered)

  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      button.textContent = `Edit my project at ${homeShort(app.dir)}?`
      button.classList.add('confirm')
      note.textContent = 'This is your project folder — files will change on disk. Click again to confirm.'
      return
    }

    const log = h('div', { className: 'fix-log' })
    showState(
      win.stage,
      h('div', { className: 'spinner' }),
      h('div', { textContent: 'Reading the app and the error…' }),
      log,
    )

    const stop = window.reef.onFixing(({ phase, file }) => {
      if (phase === 'writing') log.append(h('div', { textContent: `✓ rewrote ${file}` }))
    })

    const result = await window.reef.fix(app.id)
    stop?.()

    if (!result.ok) {
      showState(
        win.stage,
        h('div', { className: 'err', textContent: 'Could not fix it' }),
        h('div', { textContent: result.error ?? '' }),
      )
      return
    }

    showState(
      win.stage,
      h('div', { className: 'spinner' }),
      h('div', { textContent: `Fixed ${result.files.join(', ')} — restarting…` }),
    )
    onDone()
  })

  wrap.append(button, note)
  return wrap
}

async function reopen(id) {
  closeWindow(id)
  const apps = await window.reef.listApps()
  const fresh = apps.find((a) => a.id === id)
  if (fresh) openApp(fresh)
}

async function openApp(app, at) {
  if (openWindows.has(app.id)) return focusWindow(app.id)

  const win = makeWindow(app, at)
  openWindows.set(app.id, { ...win, app, minimized: false, maximized: Boolean(at?.maximized) })
  // A session saved full screen comes back full screen; the class is all the
  // state, the inline geometry underneath is the restore target.
  if (at?.maximized) win.el.classList.add('maximized')

  // After the map entry exists, not inside makeWindow: focusWindow walks
  // openWindows to clear the class off the others, so a window focused before
  // it was registered would mark nothing.
  focusWindow(app.id)
  syncDock()

  if (app.status === 'broken') {
    showState(
      win.stage,
      h('div', { className: 'err', textContent: 'This app could not be read' }),
      h('pre', { textContent: app.error ?? 'Unknown error' }),
      fixPanel(win, app, () => reopen(app.id)),
    )
    return
  }

  showState(
    win.stage,
    h('div', { className: 'spinner' }),
    h('div', { textContent: app.type === 'static' ? 'Opening…' : 'Starting server…' }),
  )

  const result = await window.reef.launch(app.id)

  // The window may have been closed while the server was coming up.
  if (!openWindows.has(app.id)) return

  if (!result.ok) {
    showState(
      win.stage,
      h('div', { className: 'err', textContent: 'Failed to start' }),
      h('div', { textContent: result.error ?? '' }),
      result.logs?.length ? h('pre', { textContent: result.logs.join('\n') }) : null,
      fixPanel(win, app, () => reopen(app.id)),
    )
    return
  }

  // `allow` comes from main, derived from the app's manifest. Without it
  // Permissions Policy denies the frame the microphone and camera outright —
  // getUserMedia rejects before the user is ever asked.
  win.url = result.url
  win.frame = h('iframe', { src: result.url, title: app.name, allow: result.allow ?? '' })
  win.stage.replaceChildren(win.frame)
}

// ------------------------------------------------------------- edit chat

const bubble = (kind, text) => h('div', { className: `msg ${kind}`, textContent: text })

/**
 * The chat pane beside a reef-built app. The conversation itself lives in
 * main and survives the pane being toggled; only closing the window ends it.
 * The pane widens the window rather than squeezing the app — the app is the
 * point, the chat is a sidecar.
 */
function toggleEditPane(id) {
  const win = openWindows.get(id)
  if (!win) return
  if (win.chat) return closeEditPane(win)

  const log = h('div', { className: 'chat-log' })
  const input = h('input', { className: 'chat-input', placeholder: 'Describe a change…' })
  const send = h('button', { className: 'chat-send', type: 'submit', textContent: '↑' })
  const form = h('form', { className: 'chat-form' }, input, send)
  const paneClose = h('button', { className: 'chat-close', title: 'Hide chat', textContent: '×' })
  const aside = h(
    'aside',
    { className: 'chat' },
    h('div', { className: 'chat-head' }, h('span', { textContent: 'Edit with AI' }), paneClose),
    log,
    form,
  )

  paneClose.addEventListener('click', () => closeEditPane(win))

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const message = input.value.trim()
    if (!message || input.disabled) return

    input.value = ''
    input.disabled = true
    send.disabled = true
    log.append(bubble('user', message))
    const progress = h('div', { className: 'chat-progress', textContent: 'Reading the app…' })
    log.append(progress)
    log.scrollTop = log.scrollHeight

    const result = await window.reef.edit({ id, message })

    progress.remove()
    log.append(
      result.ok
        ? bubble('assistant', result.reply || 'Done.')
        : bubble('err', result.error ?? 'Something went wrong — the app may be part-changed.'),
    )
    log.scrollTop = log.scrollHeight
    input.disabled = false
    send.disabled = false
    input.focus()
  })

  win.chat = aside
  win.el.classList.add('editing')
  // Give the chat its own room instead of taking it from the app.
  win.el.style.width = `${Math.min(window.innerWidth - win.el.offsetLeft - 16, win.el.offsetWidth + 360)}px`
  win.body.append(aside)
  input.focus()
}

function closeEditPane(win) {
  if (!win.chat) return
  win.chat.remove()
  win.chat = null
  win.el.classList.remove('editing')
  win.el.style.width = `${Math.max(320, win.el.offsetWidth - 360)}px`
}

// Progress for whichever window's turn is running — every event carries the
// app id, so concurrent sessions cannot cross streams.
window.reef.onEditing(({ id, phase, file }) => {
  const line = openWindows.get(id)?.chat?.querySelector('.chat-progress')
  if (!line) return
  if (phase === 'thinking') line.textContent = 'Thinking…'
  if (phase === 'writing') line.textContent = `Rewriting ${file}…`
})

// A change on disk — from an edit turn or the user's own editor — reloads the
// frame. Re-navigation, not reload(): the frame is cross-origin, and the
// gateway serves no-store so the same URL comes back fresh.
window.reef.onChanged(({ id }) => {
  const win = openWindows.get(id)
  if (win?.frame) win.frame.src = win.url
})

// ------------------------------------------------------------ ⌘K palette

const paletteEl = document.getElementById('palette')
const promptEl = document.getElementById('prompt')
const progressEl = document.getElementById('progress')
const paletteHintEl = document.getElementById('palette-hint')
const paletteEnterEl = document.getElementById('palette-enter')
const paletteSubmitEl = document.getElementById('palette-submit')
const paletteEscEl = document.getElementById('palette-esc-label')

/**
 * A build is background work from the moment it has an id. `generating` only
 * covers the beat before that — one round trip to main — so the palette is
 * never modal for the minutes the agent actually takes. `paletteBuildId` is
 * which in-flight build the palette is narrating, if it is open at all, and
 * `paletteStatusEl` is that narration's live last line.
 */
let generating = false
let paletteBuildId = null
let paletteStatusEl = null

/**
 * 'build' or 'key'.
 *
 * Asking for a key *after* someone has described the app they want is the
 * wrong order: they did the work and got a refusal. If there is no key, the
 * palette asks for one first, in the same box, and then carries on.
 */
let paletteMode = 'build'

function setPaletteMode(mode) {
  paletteMode = mode
  const needsKey = mode === 'key'

  paletteHintEl.hidden = !needsKey
  // 'go', not 'build': Enter is routed — it may open an app or answer in
  // place, and promising "build" before the intent is known would lie.
  paletteEnterEl.textContent = needsKey ? 'save key' : 'go'
  promptEl.type = needsKey ? 'password' : 'text'
  promptEl.placeholder = needsKey ? 'sk-ant-…' : 'Describe an app to build, or name one to open…'
}

/**
 * While the palette is watching a build, Enter has nothing to offer and esc
 * does not abandon anything — say so in the foot.
 */
function setWatching(watching) {
  paletteSubmitEl.hidden = watching
  paletteEscEl.textContent = watching ? 'continue in background' : 'close'
}

async function openPalette() {
  paletteEl.hidden = false
  paletteBuildId = null
  paletteStatusEl = null
  setWatching(false)
  progressEl.replaceChildren()
  promptEl.value = ''
  promptEl.disabled = false
  promptEl.focus()

  // Optimistically 'build' until we know: the sheet should never flash a
  // request for credentials at someone who already has them.
  const settings = await window.reef.getSettings()
  setPaletteMode(settings.hasApiKey ? 'build' : 'key')
  promptEl.focus()
}

/** Point the palette at a build in flight: replay its feed, then follow. */
function watchBuild(id) {
  const build = pendingBuilds.get(id)
  if (!build) return

  setPaletteMode('build')
  paletteBuildId = id
  paletteEl.hidden = false
  promptEl.value = build.prompt
  promptEl.disabled = true
  progressEl.replaceChildren()
  paletteStatusEl = null
  for (const line of build.lines) progressLine(line.text, line)
  paletteStatusEl = statusLine(build.status)
  setWatching(true)
}

async function saveKeyFromPalette() {
  const key = promptEl.value.trim()
  if (!key) return

  promptEl.disabled = true
  const result = await window.reef.updateSettings({ anthropicApiKey: key })
  promptEl.disabled = false

  if (!result.ok) {
    progressLine('Could not save that key', { icon: '×', className: 'err' })
    promptEl.focus()
    return
  }

  promptEl.value = ''
  setPaletteMode('build')
  progressEl.replaceChildren()
  progressLine('Key saved on this machine. Now, what should it build?', { icon: '✓' })
  promptEl.focus()
}

// Closing the palette never cancels anything: a build in flight keeps its
// bubbling tile in the dock and reports back through onGenerated.
function closePalette() {
  paletteEl.hidden = true
}

function progressLine(text, { icon = '', className = '' } = {}) {
  const line = h(
    'div',
    { className: `line ${className}`.trim() },
    h('span', { className: 'tick', textContent: icon }),
    h('span', { textContent: text }),
  )
  // The live status line stays last; finished lines slot in above it.
  if (paletteStatusEl?.parentElement === progressEl) paletteStatusEl.before(line)
  else progressEl.append(line)
  return line
}

/** The feed's last line: what the agent is doing right now, bubbling. */
function statusLine(text) {
  const line = h(
    'div',
    { className: 'line' },
    h('span', { className: 'bubbles' }, h('i'), h('i'), h('i')),
    h('span', { className: 'status-text', textContent: text }),
  )
  progressEl.append(line)
  return line
}

async function build() {
  const prompt = promptEl.value.trim()
  if (!prompt || generating || promptEl.disabled) return

  generating = true
  promptEl.disabled = true
  progressEl.replaceChildren()
  // Intent-neutral: at this point the router has not yet said whether this
  // is a build, an open, or a question.
  paletteStatusEl = statusLine('Reading that…')

  // Resolves as soon as main knows what this is: an open or a reply settles
  // it outright; a build resolves once it has an id, and the work carries on
  // in main, reporting back through onGenerating / onGenerated.
  const result = await window.reef.generate(prompt)
  generating = false

  const settle = () => {
    paletteStatusEl?.remove()
    paletteStatusEl = null
    promptEl.disabled = false
  }

  if (!result.ok) {
    settle()
    if (paletteEl.hidden) {
      toast(result.error ?? 'Generation failed', { error: true })
    } else {
      progressLine(result.error ?? 'Generation failed', { icon: '×', className: 'err' })
      promptEl.focus()
    }
    return
  }

  // "check my emails" with a mail app installed: not a build request, an
  // intent — open the app that answers it.
  if (result.action === 'open') {
    settle()
    const apps = await window.reef.listApps()
    const found = apps.find((a) => a.id === result.id)
    if (!found) {
      progressLine(`Meant to open "${result.id}", but it is gone.`, { icon: '×', className: 'err' })
      promptEl.focus()
      return
    }
    closePalette()
    openApp(found)
    return
  }

  // Neither an app to open nor one to build: the router answers in place,
  // the prompt stays for rephrasing, and nothing expensive ran.
  if (result.action === 'reply') {
    settle()
    progressLine(result.reply ?? '', { className: 'reply' })
    promptEl.focus()
    return
  }

  trackBuild(result.id, prompt)
  paletteBuildId = result.id
  setWatching(true)
}

/**
 * What the dock tooltip and the palette's live line say for each event. The
 * 'thinking' tool names are the agent's own vocabulary; this is the
 * translation into the user's.
 */
const TOOL_STATUS = {
  write_file: 'Writing the app…',
  read_file: 'Reading it back…',
  list_files: 'Surveying the files…',
}

function buildStatus({ phase, tool }, current) {
  if (phase === 'scaffolding') return 'Making a home for it…'
  if (phase === 'thinking') return TOOL_STATUS[tool] ?? 'Designing the app…'
  if (phase === 'done') return 'Surfacing…'
  // 'writing' gets its own ✓ line; the live line keeps the current activity
  // rather than echoing that line word for word.
  return current
}

window.reef.onGenerating((event) => {
  const build = pendingBuilds.get(event.id)
  if (!build) return

  build.status = buildStatus(event, build.status)
  // The tooltip favours the last concrete thing; the live line, the activity.
  build.el.title = event.phase === 'writing' ? `Wrote ${event.file}` : build.status
  if (event.phase === 'writing') build.lines.push({ text: `Wrote ${event.file}`, icon: '✓' })

  if (paletteBuildId !== event.id || paletteEl.hidden) return
  if (event.phase === 'writing') progressLine(`Wrote ${event.file}`, { icon: '✓' })
  const statusText = paletteStatusEl?.querySelector('.status-text')
  if (statusText) statusText.textContent = build.status
})

window.reef.onGenerated(async (result) => {
  // A terminal failure can arrive without an id; with a single build in
  // flight there is no ambiguity about whose it is.
  const id = result.id ?? (pendingBuilds.size === 1 ? [...pendingBuilds.keys()][0] : null)
  const build = pendingBuilds.get(id)
  if (build) {
    build.el.remove()
    pendingBuilds.delete(id)
  }

  const watching = paletteBuildId === id && !paletteEl.hidden
  if (paletteBuildId === id) {
    paletteBuildId = null
    paletteStatusEl?.remove()
    paletteStatusEl = null
    setWatching(false)
    promptEl.disabled = false
  }

  await renderDock()

  if (!result.ok) {
    if (watching) {
      // The description is still in the box — rephrase and go again.
      progressLine(result.error ?? 'Generation failed', { icon: '×', className: 'err' })
      promptEl.focus()
    } else {
      toast(result.error ?? 'The build failed', { error: true })
    }
    return
  }

  // The new tile hatches in place of the bubbles.
  const hatchling = dockButtons.get(id)
  if (hatchling) {
    hatchling.classList.add('hatched')
    setTimeout(() => hatchling.classList.remove('hatched'), 1400)
  }

  const apps = await window.reef.listApps()
  const created = apps.find((a) => a.id === id)

  if (watching) {
    // They stayed for the whole thing: open it, as ⌘K always has.
    progressLine(`Built ${created?.name ?? id}`, { icon: '✓' })
    setTimeout(() => {
      closePalette()
      if (created) openApp(created)
    }, 450)
  } else if (created) {
    // They went off to do something else: announce, don't interrupt.
    toast(`${created.name} is ready — it's in the dock`)
  }
})

promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    if (paletteMode === 'key') saveKeyFromPalette()
    else build()
  }
})

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteEl.hidden ? openPalette() : closePalette()
    return
  }
  if (event.key === 'Escape') {
    closePalette()
    settingsEl.hidden = true
  }
})

paletteEl.addEventListener('mousedown', (event) => {
  if (event.target === paletteEl) closePalette()
})

document.getElementById('new-app').addEventListener('click', openPalette)

// ------------------------------------------------------- linking folders

const canvasEl = document.getElementById('canvas')

function toast(text, { error = false } = {}) {
  const el = h('div', { className: `toast${error ? ' err' : ''}`, textContent: text })
  document.body.append(el)
  setTimeout(() => el.remove(), 4200)
}

// Drop any project folder onto the desktop to run it where it already lives —
// nothing is copied, so editing it in your editor edits what the desktop runs.
// dragenter/dragleave fire for every child element the cursor crosses, so a
// bare "leave clears it" rule leaves the prompt stuck on screen. Count depth
// instead and only clear when the drag has genuinely left the desktop.
let dragDepth = 0
const hasFiles = (event) => event.dataTransfer?.types?.includes('Files')
const clearDropState = () => {
  dragDepth = 0
  canvasEl.classList.remove('dropping')
}

canvasEl.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  canvasEl.classList.add('dropping')
})

canvasEl.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'link'
})

canvasEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) canvasEl.classList.remove('dropping')
})

// A drag abandoned outside the window fires neither drop nor dragleave.
document.addEventListener('dragend', clearDropState)
window.addEventListener('blur', clearDropState)

canvasEl.addEventListener('drop', async (event) => {
  event.preventDefault()
  clearDropState()

  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => window.reef.pathForFile(file))
    .filter(Boolean)

  if (!paths.length) return

  const result = await window.reef.link(paths)
  await renderDock()

  if (result.errors?.length) {
    toast(result.errors[0].error, { error: true })
  } else {
    toast(`Linked ${result.linked} folder${result.linked === 1 ? '' : 's'}`)
  }
})

// ---------------------------------------------------------- wallpaper

/**
 * Paint a background onto the canvas.
 *
 * Image and gradient go into the same property, so the rest of the styling
 * does not branch. The scrim opacities ride along as custom properties
 * because they are tuned per picture — see src/core/backgrounds.js.
 */
function applyBackground(background) {
  if (!background) return

  canvasEl.style.backgroundImage =
    background.kind === 'image'
      ? `url('../../assets/backgrounds/${background.file}')`
      : background.css

  canvasEl.style.setProperty('--scrim-top', String(background.scrim.top))
  canvasEl.style.setProperty('--scrim-bottom', String(background.scrim.bottom))
  canvasEl.style.setProperty('--scrim-vignette', String(background.scrim.vignette))
  canvasEl.dataset.background = background.id
}

/** The swatch shown in the picker is the background itself, scaled down. */
function swatchFor(background) {
  const el = h('span', { className: 'swatch' })
  el.style.backgroundImage =
    background.kind === 'image'
      ? `url('../../assets/backgrounds/${background.file}')`
      : background.css
  return el
}

// ------------------------------------------------------------- settings

const settingsEl = document.getElementById('settings')
const ownerNameEl = document.getElementById('owner-name')
const backgroundsEl = document.getElementById('backgrounds')
const appsFolderEl = document.getElementById('apps-folder')
const appsFolderStatusEl = document.getElementById('apps-folder-status')
const apiKeyEl = document.getElementById('api-key')
const apiKeyStatusEl = document.getElementById('api-key-status')

function setStatus(el, text, { on = false } = {}) {
  el.textContent = text
  el.classList.toggle('on', on)
}

/** Chosen in the sheet but not yet saved. */
let pendingBackgroundId = null

function renderBackgroundPicker(backgrounds, selectedId) {
  pendingBackgroundId = selectedId
  backgroundsEl.replaceChildren()

  for (const background of backgrounds) {
    const button = h(
      'button',
      {
        className: `bg-option${background.id === selectedId ? ' selected' : ''}`,
        title: background.name,
        type: 'button',
      },
      swatchFor(background),
      h('span', { className: 'bg-name', textContent: background.name }),
    )

    button.addEventListener('click', () => {
      pendingBackgroundId = background.id
      for (const other of backgroundsEl.children) other.classList.remove('selected')
      button.classList.add('selected')
      // Apply straight away: choosing a wallpaper from a thumbnail is
      // guesswork, and the canvas is right there behind the sheet.
      applyBackground(background)
    })

    backgroundsEl.append(button)
  }
}

async function openSettings() {
  const settings = await window.reef.getSettings()

  renderBackgroundPicker(settings.backgrounds ?? [], settings.background?.id ?? null)
  ownerNameEl.value = settings.ownerName ?? ''
  appsFolderEl.value = settings.appsFolder ?? ''

  // The key itself never leaves the main process, so the field starts empty
  // and typing into it is the only way to change it.
  apiKeyEl.value = ''
  if (settings.apiKeyFromEnvironment) {
    apiKeyEl.placeholder = 'Using ANTHROPIC_API_KEY from the environment'
    setStatus(apiKeyStatusEl, 'Inherited from the shell this was launched from.', { on: true })
  } else if (settings.hasApiKey) {
    apiKeyEl.placeholder = 'Saved — type to replace'
    setStatus(apiKeyStatusEl, 'A key is saved.', { on: true })
  } else {
    apiKeyEl.placeholder = 'sk-ant-…'
    setStatus(apiKeyStatusEl, 'No key. ⌘K and Fix with AI are unavailable.')
  }

  await countDiscovered(settings.appsFolder)
  settingsEl.hidden = false
  appsFolderEl.focus()
}

/** Say how many apps the folder actually yields — a silent zero reads as broken. */
async function countDiscovered(folder) {
  if (!folder) {
    setStatus(appsFolderStatusEl, 'No folder set.')
    return
  }

  const apps = await window.reef.listApps()
  const found = apps.filter((a) => a.discovered).length

  if (found === 0) {
    setStatus(appsFolderStatusEl, 'No apps found — add a reef.json to a project in here.')
  } else {
    setStatus(appsFolderStatusEl, `Found ${found} app${found === 1 ? '' : 's'}.`, { on: true })
  }
}

const closeSettings = async () => {
  settingsEl.hidden = true
  // The preview applied live; closing without saving has to put it back.
  const settings = await window.reef.getSettings()
  applyBackground(settings.background)
}

async function saveSettings() {
  const patch = {
    appsFolder: appsFolderEl.value,
    backgroundId: pendingBackgroundId,
    ownerName: ownerNameEl.value,
  }

  // An untouched field must not wipe a saved key, so only send what was typed.
  if (apiKeyEl.value.trim()) patch.anthropicApiKey = apiKeyEl.value

  const result = await window.reef.updateSettings(patch)
  if (!result.ok) {
    toast('Could not save settings', { error: true })
    return
  }

  await renderDock()
  closeSettings()

  const found = result.apps.filter((a) => a.discovered).length
  toast(found ? `Settings saved — ${found} app${found === 1 ? '' : 's'} found` : 'Settings saved')
}

document.getElementById('browse-folder').addEventListener('click', async () => {
  const result = await window.reef.chooseFolder()
  if (result.ok) appsFolderEl.value = result.dir
})

document.getElementById('open-settings').addEventListener('click', openSettings)
document.getElementById('close-settings').addEventListener('click', closeSettings)
document.getElementById('save-settings').addEventListener('click', saveSettings)

settingsEl.addEventListener('mousedown', (event) => {
  if (event.target === settingsEl) closeSettings()
})

settingsEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    saveSettings()
  }
})

// --------------------------------------------------------------- hello

/**
 * The startup hello.
 *
 * Never blocks. The greeting is pure text floating over the reef —
 * pointer-events: none, so it cannot intercept a single click — and the name
 * prompt is a small card with no scrim behind it and no focus steal: the
 * desktop stays fully usable while it waits, and "maybe later" costs nothing
 * (it just asks again next launch).
 */
function showHello(children, { interactive = false } = {}) {
  document.getElementById('hello')?.remove()
  const el = h('div', { id: 'hello', className: interactive ? 'ask' : '' }, ...children)
  document.body.append(el)
  return el
}

function fadeHello(el, after = 7000) {
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 900)
  }, after)
}

const helloLines = ({ title, sub }) => [
  h('div', { className: 'hello-title', textContent: title }),
  h('div', { className: 'hello-sub', textContent: sub }),
]

function greet(name) {
  fadeHello(showHello(helloLines(greetingFor(name, new Date().getHours()))))
}

function askForName() {
  const input = h('input', {
    className: 'hello-input',
    placeholder: 'Your name',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 60,
  })
  const save = h('button', { className: 'hello-save', type: 'submit', textContent: 'Say hello' })
  const later = h('button', { className: 'hello-later', type: 'button', textContent: 'maybe later' })
  const form = h('form', { className: 'hello-form' }, input, save)

  const el = showHello(
    [
      h('div', { className: 'hello-title', textContent: 'Welcome to your reef' }),
      h('div', {
        className: 'hello-sub',
        textContent: 'I don’t think we’ve met — what should I call you?',
      }),
      form,
      later,
    ],
    { interactive: true },
  )

  later.addEventListener('click', () => fadeHello(el, 0))

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = input.value.trim()
    if (!name || input.disabled) return

    input.disabled = true
    save.disabled = true
    const result = await window.reef.updateSettings({ ownerName: name })
    if (!result.ok) {
      input.disabled = false
      save.disabled = false
      return
    }

    // Same spot, new voice: the card becomes the greeting it could not give.
    el.classList.remove('ask')
    el.replaceChildren(
      ...helloLines({ title: `Lovely to meet you, ${name}`, sub: 'The reef is yours.' }),
    )
    fadeHello(el)
  })
}

// --------------------------------------------------------------- wiring

refreshEl.addEventListener('click', renderDock)

window.reef.onState(({ id, status, error, logs }) => {
  const win = openWindows.get(id)
  if (win && status === 'crashed') {
    showState(
      win.stage,
      h('div', { className: 'err', textContent: 'App crashed' }),
      h('div', { textContent: error ?? '' }),
      logs?.length ? h('pre', { textContent: logs.join('\n') }) : null,
      fixPanel(win, win.app, () => reopen(id)),
    )
  }
})

renderDock()

// Put back whatever the last session had on screen. Runs alongside renderDock
// on purpose — neither waits on the other.
restoreSession()

// Paint the saved wallpaper. The CSS default covers the frame before this
// resolves, so there is no flash of bare canvas. Then say hello — by name if
// we know it, otherwise by asking for one.
window.reef.getSettings().then((settings) => {
  applyBackground(settings.background)
  if (settings.ownerName) greet(settings.ownerName)
  else askForName()
})
