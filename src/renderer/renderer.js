/**
 * The desktop canvas.
 *
 * Owns icon layout and window management. Apps live in iframes on their own
 * origin, which means the parent cannot see inside them — that shapes two of
 * the behaviours here: a pointer shield during drags, and an explicit focus
 * click-catcher, since a click landing inside an iframe never reaches us.
 */

const iconsEl = document.getElementById('icons')
const windowsEl = document.getElementById('windows')
const shieldEl = document.getElementById('shield')
const refreshEl = document.getElementById('refresh')

/** id -> { el, body, app } */
const openWindows = new Map()
let topZ = 10
let cascade = 0

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props)
  for (const child of children.flat()) {
    if (child != null) el.append(child)
  }
  return el
}

function glyphFor(app) {
  if (app.icon) return app.icon
  if (app.status === 'broken') return '!'
  return app.name.slice(0, 1).toUpperCase()
}

// ---------------------------------------------------------------- icons

async function renderIcons() {
  const apps = await window.desktop.listApps()
  iconsEl.replaceChildren()

  if (apps.length === 0) {
    iconsEl.append(h('div', { id: 'empty', textContent: 'No apps found in apps/' }))
    return
  }

  for (const app of apps) {
    const button = h(
      'button',
      { className: `icon${app.status === 'broken' ? ' broken' : ''}`, title: app.error ?? app.name },
      h('span', { className: 'glyph', textContent: glyphFor(app) }),
      h('span', { className: 'label', textContent: app.name }),
      app.type && app.type !== 'static'
        ? h('span', { className: 'badge', textContent: 'server' })
        : null,
    )
    button.addEventListener('click', () => openApp(app))
    iconsEl.append(button)
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
  if (win.app.type && win.app.type !== 'static') window.desktop.stop(id)
}

function makeWindow(app) {
  const offset = (cascade++ % 6) * 28

  const body = h('div', { className: 'body' })
  const titlebar = h(
    'div',
    { className: 'titlebar' },
    h('span', { textContent: app.icon ?? '' }),
    h('span', { className: 'name', textContent: app.name }),
    h('span', { className: 'spacer' }),
  )

  const close = h('button', { title: 'Close', textContent: '×' })
  close.addEventListener('click', () => closeWindow(app.id))
  titlebar.append(close)

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

    const stop = window.desktop.onFixing(({ phase, file }) => {
      if (phase === 'writing') log.append(h('div', { textContent: `✓ rewrote ${file}` }))
    })

    const result = await window.desktop.fix(app.id)
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
  const apps = await window.desktop.listApps()
  const fresh = apps.find((a) => a.id === id)
  if (fresh) openApp(fresh)
}

async function openApp(app) {
  if (openWindows.has(app.id)) return focusWindow(app.id)

  const win = makeWindow(app)
  openWindows.set(app.id, { ...win, app })

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

  const result = await window.desktop.launch(app.id)

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
let generating = false

function openPalette() {
  paletteEl.hidden = false
  progressEl.replaceChildren()
  promptEl.value = ''
  promptEl.disabled = false
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

  const result = await window.desktop.generate(prompt)
  pending.remove()
  generating = false
  promptEl.disabled = false

  if (!result.ok) {
    progressLine(result.error ?? 'Generation failed', { icon: '×', className: 'err' })
    promptEl.focus()
    return
  }

  progressLine(`Built ${result.id}`, { icon: '✓' })
  await renderIcons()

  // Give the success line a beat to register before the app takes over.
  setTimeout(async () => {
    paletteEl.hidden = true
    const apps = await window.desktop.listApps()
    const created = apps.find((a) => a.id === result.id)
    if (created) openApp(created)
  }, 450)
}

window.desktop.onGenerating(({ phase, file }) => {
  if (!generating) return
  if (phase === 'writing') progressLine(`Writing ${file}`, { icon: '✓' })
})

promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    build()
  }
})

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteEl.hidden ? openPalette() : closePalette()
    return
  }
  if (event.key === 'Escape') closePalette()
})

paletteEl.addEventListener('mousedown', (event) => {
  if (event.target === paletteEl) closePalette()
})

document.getElementById('new-app').addEventListener('click', openPalette)

// ------------------------------------------------------- linking folders

const desktopEl = document.getElementById('desktop')

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
  desktopEl.classList.remove('dropping')
}

desktopEl.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  desktopEl.classList.add('dropping')
})

desktopEl.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'link'
})

desktopEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) desktopEl.classList.remove('dropping')
})

// A drag abandoned outside the window fires neither drop nor dragleave.
document.addEventListener('dragend', clearDropState)
window.addEventListener('blur', clearDropState)

desktopEl.addEventListener('drop', async (event) => {
  event.preventDefault()
  clearDropState()

  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => window.desktop.pathForFile(file))
    .filter(Boolean)

  if (!paths.length) return

  const result = await window.desktop.link(paths)
  await renderIcons()

  if (result.errors?.length) {
    toast(result.errors[0].error, { error: true })
  } else {
    toast(`Linked ${result.linked} folder${result.linked === 1 ? '' : 's'}`)
  }
})

// --------------------------------------------------------------- wiring

refreshEl.addEventListener('click', renderIcons)

window.desktop.onState(({ id, status, error, logs }) => {
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

renderIcons()
