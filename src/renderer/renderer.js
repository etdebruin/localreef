/**
 * The desktop canvas.
 *
 * Owns icon layout and window management. Apps live in iframes on their own
 * origin, which means the parent cannot see inside them — that shapes two of
 * the behaviours here: a pointer shield during drags, and an explicit focus
 * click-catcher, since a click landing inside an iframe never reaches us.
 */

const dockAppsEl = document.getElementById('dock-apps')
const emptyEl = document.getElementById('empty')
const windowsEl = document.getElementById('windows')
const shieldEl = document.getElementById('shield')
const refreshEl = document.getElementById('refresh')

/** id -> { el, body, app, minimized } */
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
async function renderDock() {
  const apps = await window.reef.listApps()
  dockAppsEl.replaceChildren()
  dockButtons.clear()

  emptyEl.hidden = apps.length > 0

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

// -------------------------------------------------------------- windows

function focusWindow(id) {
  const win = openWindows.get(id)
  if (!win) return
  win.el.style.zIndex = String(++topZ)
}

function closeWindow(id) {
  const win = openWindows.get(id)
  if (!win) return
  win.el.remove()
  openWindows.delete(id)
  // Static apps have no process; stopping a server app frees it immediately
  // rather than waiting out keepAlive, which is the right call for M1.
  if (win.app.type && win.app.type !== 'static') window.reef.stop(id)
  syncDock()
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
  syncDock()
}

function restoreWindow(id) {
  const win = openWindows.get(id)
  if (!win) return
  win.minimized = false
  win.el.hidden = false
  focusWindow(id)
  syncDock()
}

function makeWindow(app) {
  const offset = (cascade++ % 6) * 28

  const body = h('div', { className: 'body' })
  const titlebar = h(
    'div',
    { className: 'titlebar' },
    tileFor(app, 'tile-sm'),
    h('span', { className: 'name', textContent: app.name }),
    h('span', { className: 'spacer' }),
  )

  const minimize = h('button', { className: 'minimize', title: 'Minimize', textContent: '–' })
  minimize.addEventListener('click', () => minimizeWindow(app.id))

  // × quits the app, not just the window: for a server app it stops the
  // process. Minimize is the way to put it away and keep it running.
  const close = h('button', { className: 'close', title: 'Quit', textContent: '×' })
  close.addEventListener('click', () => closeWindow(app.id))

  titlebar.append(minimize, close)

  const resize = h('div', { className: 'resize' })
  const el = h('div', { className: 'window' }, titlebar, body, resize)

  el.style.left = `${90 + offset}px`
  el.style.top = `${70 + offset}px`
  el.style.width = '820px'
  el.style.height = '560px'
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
  return { el, body }
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

  let armed = !app.linked

  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      button.textContent = `Edit my project at ${homeShort(app.dir)}?`
      button.classList.add('confirm')
      note.textContent = 'This is a linked folder — files will change on disk. Click again to confirm.'
      return
    }

    const log = h('div', { className: 'fix-log' })
    showState(
      win.body,
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
        win.body,
        h('div', { className: 'err', textContent: 'Could not fix it' }),
        h('div', { textContent: result.error ?? '' }),
      )
      return
    }

    showState(
      win.body,
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

async function openApp(app) {
  if (openWindows.has(app.id)) return focusWindow(app.id)

  const win = makeWindow(app)
  openWindows.set(app.id, { ...win, app, minimized: false })
  syncDock()

  if (app.status === 'broken') {
    showState(
      win.body,
      h('div', { className: 'err', textContent: 'This app could not be read' }),
      h('pre', { textContent: app.error ?? 'Unknown error' }),
      fixPanel(win, app, () => reopen(app.id)),
    )
    return
  }

  showState(
    win.body,
    h('div', { className: 'spinner' }),
    h('div', { textContent: app.type === 'static' ? 'Opening…' : 'Starting server…' }),
  )

  const result = await window.reef.launch(app.id)

  // The window may have been closed while the server was coming up.
  if (!openWindows.has(app.id)) return

  if (!result.ok) {
    showState(
      win.body,
      h('div', { className: 'err', textContent: 'Failed to start' }),
      h('div', { textContent: result.error ?? '' }),
      result.logs?.length ? h('pre', { textContent: result.logs.join('\n') }) : null,
      fixPanel(win, app, () => reopen(app.id)),
    )
    return
  }

  win.body.replaceChildren(h('iframe', { src: result.url, title: app.name }))
}

// ------------------------------------------------------------ ⌘K palette

const paletteEl = document.getElementById('palette')
const promptEl = document.getElementById('prompt')
const progressEl = document.getElementById('progress')
const paletteHintEl = document.getElementById('palette-hint')
const paletteEnterEl = document.getElementById('palette-enter')
let generating = false

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
  paletteEnterEl.textContent = needsKey ? 'save key' : 'build'
  promptEl.type = needsKey ? 'password' : 'text'
  promptEl.placeholder = needsKey ? 'sk-ant-…' : 'Describe an app to build…'
}

async function openPalette() {
  paletteEl.hidden = false
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

function closePalette() {
  if (generating) return
  paletteEl.hidden = true
}

function progressLine(text, { icon = '', className = '' } = {}) {
  const line = h(
    'div',
    { className: `line ${className}`.trim() },
    h('span', { className: 'tick', textContent: icon }),
    h('span', { textContent: text }),
  )
  progressEl.append(line)
  return line
}

async function build() {
  const prompt = promptEl.value.trim()
  if (!prompt || generating) return

  generating = true
  promptEl.disabled = true
  progressEl.replaceChildren()

  const pending = progressLine('Designing the app…', { icon: '▸' })

  const result = await window.reef.generate(prompt)
  pending.remove()
  generating = false
  promptEl.disabled = false

  if (!result.ok) {
    progressLine(result.error ?? 'Generation failed', { icon: '×', className: 'err' })
    promptEl.focus()
    return
  }

  progressLine(`Built ${result.id}`, { icon: '✓' })
  await renderDock()

  // Give the success line a beat to register before the app takes over.
  setTimeout(async () => {
    paletteEl.hidden = true
    const apps = await window.reef.listApps()
    const created = apps.find((a) => a.id === result.id)
    if (created) openApp(created)
  }, 450)
}

window.reef.onGenerating(({ phase, file }) => {
  if (!generating) return
  if (phase === 'writing') progressLine(`Writing ${file}`, { icon: '✓' })
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
  const patch = { appsFolder: appsFolderEl.value, backgroundId: pendingBackgroundId }

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

// --------------------------------------------------------------- wiring

refreshEl.addEventListener('click', renderDock)

window.reef.onState(({ id, status, error, logs }) => {
  const win = openWindows.get(id)
  if (win && status === 'crashed') {
    showState(
      win.body,
      h('div', { className: 'err', textContent: 'App crashed' }),
      h('div', { textContent: error ?? '' }),
      logs?.length ? h('pre', { textContent: logs.join('\n') }) : null,
      fixPanel(win, win.app, () => reopen(id)),
    )
  }
})

renderDock()

// Paint the saved wallpaper. The CSS default covers the frame before this
// resolves, so there is no flash of bare canvas.
window.reef.getSettings().then((settings) => applyBackground(settings.background))
