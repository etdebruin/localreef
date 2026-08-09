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

  // --- the wallpaper actually loads ---
  // A wrong path or a CSP that blocks the asset both fail silently: the canvas
  // just shows its fallback colour and nothing errors. So resolve the URL out
  // of the computed style and then actually fetch it through an Image.
  const wallpaper = await js(`(async () => {
    const el = document.getElementById('canvas')
    const bg = getComputedStyle(el).backgroundImage
    const match = bg.match(/url\\("?([^")]+)"?\\)/)
    if (!match) return { declared: false, bg }
    const loaded = await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => resolve(null)
      img.src = match[1]
    })
    return { declared: true, file: match[1].split('/').pop(), loaded }
  })()`)

  check('the canvas declares a wallpaper', wallpaper?.declared === true, JSON.stringify(wallpaper))
  check(
    'the wallpaper image actually loads',
    Boolean(wallpaper?.loaded?.w > 0),
    JSON.stringify(wallpaper),
  )

  // --- icons are circular bubbles, uniform, and mode-appropriate ---
  const tiles = await js(`(() => [...document.querySelectorAll('.dock-app .tile')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      cls: el.className,
      radius: getComputedStyle(el).borderTopLeftRadius,
    }
  }))()`)

  check('every app has a tile', Array.isArray(tiles) && tiles.length === 3, JSON.stringify(tiles))
  check(
    'every tile is a circle',
    tiles.length > 0 && tiles.every((t) => t.w === t.h && t.w > 0 && t.radius === '50%'),
    JSON.stringify(tiles.map((t) => `${t.w}x${t.h} r=${t.radius}`)),
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

  // --- hover ---
  // Driven by a real mouseMove: :hover cannot be triggered from script, so a
  // programmatic test here would assert nothing at all.
  const hoverPoint = await centreOf('.dock-app')
  if (hoverPoint) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hoverPoint.x, y: hoverPoint.y })
    await wait(220)
  }

  const hovered = await js(`(() => {
    const button = document.querySelector('.dock-app')
    const tile = button?.querySelector('.tile')
    if (!button || !tile) return null
    return {
      lifted: getComputedStyle(button).transform,
      wobble: getComputedStyle(tile).animationName,
      escaping: getComputedStyle(button, '::before').animationName,
    }
  })()`)
  check(
    'hovering swells the bubble',
    hovered && hovered.lifted !== 'none',
    JSON.stringify(hovered),
  )
  check(
    'hovering wobbles the surface',
    hovered?.wobble === 'bubble-wobble',
    `animation=${hovered?.wobble}`,
  )
  check(
    'hovering releases a bubble',
    hovered?.escaping === 'bubble-escape',
    `animation=${hovered?.escaping}`,
  )

  // Move away so the hover state does not colour anything after this.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 400 })
  await wait(200)

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
    'the titlebar tile is a circle',
    titleTile && titleTile.w === titleTile.h && titleTile.w > 0,
    `${titleTile?.w}x${titleTile?.h}`,
  )
  check(
    'the titlebar tile renders its contents',
    titleTile?.innerVisible === true,
    JSON.stringify(titleTile),
  )

  // A window you just opened is the focused one, and the chrome has to say so.
  const focus = await js(`(() => {
    const w = document.querySelector('.window')
    if (!w) return null
    const dot = w.querySelector('.titlebar button.close')
    return {
      focused: w.classList.contains('focused'),
      dotFilter: getComputedStyle(dot).filter,
    }
  })()`)
  check('a newly opened window is focused', focus?.focused === true, JSON.stringify(focus))
  check(
    'focused chrome is not drained of colour',
    focus?.dotFilter === 'none',
    `filter=${focus?.dotFilter}`,
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

  // --- background picker ---
  const picker = await js(`(() => {
    const options = [...document.querySelectorAll('.bg-option')]
    return {
      count: options.length,
      selected: options.filter((o) => o.classList.contains('selected')).length,
      // A swatch with no background is a picker you cannot use.
      swatchesPainted: options.every(
        (o) => getComputedStyle(o.querySelector('.swatch')).backgroundImage !== 'none',
      ),
    }
  })()`)
  const names = await js(`(() => [...document.querySelectorAll('.bg-option .bg-name')].map((el) => {
    const r = el.getBoundingClientRect()
    return { text: el.textContent, w: Math.round(r.width), h: Math.round(r.height) }
  }))()`)
  check(
    'each background is labelled with a visible name',
    Array.isArray(names) && names.length === 4 && names.every((n) => n.text && n.w > 0 && n.h > 0),
    JSON.stringify(names),
  )

  // Layout regression guard: the labels once rendered *outside* their section
  // and sat on top of the next heading.
  const overflow = await js(`(() => {
    const field = document.getElementById('backgrounds').closest('.field')
    const last = [...document.querySelectorAll('.bg-option')].pop()
    if (!field || !last) return null
    return {
      fieldBottom: Math.round(field.getBoundingClientRect().bottom),
      // The *label's* bottom, not the button's: the button's own box was the
      // thing that was wrong, so measuring it proved nothing.
      optionBottom: Math.round(last.querySelector('.bg-name').getBoundingClientRect().bottom),
      optionH: Math.round(last.getBoundingClientRect().height),
      swatchH: Math.round(last.querySelector('.swatch').getBoundingClientRect().height),
      swatchW: Math.round(last.querySelector('.swatch').getBoundingClientRect().width),
    }
  })()`)
  check(
    'the picker fits inside its section',
    overflow && overflow.optionBottom <= overflow.fieldBottom,
    JSON.stringify(overflow),
  )

  check('the picker lists every background', picker?.count === 4, JSON.stringify(picker))
  check('exactly one is selected', picker?.selected === 1, JSON.stringify(picker))
  check('every swatch is painted', picker?.swatchesPainted === true, JSON.stringify(picker))

  // Choosing the second one must repaint the canvas immediately, not on save.
  const second = await js(`(() => {
    const el = document.querySelectorAll('.bg-option')[1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (second) await clickAt(second)

  const previewed = await js(`(() => {
    const el = document.getElementById('canvas')
    return { id: el.dataset.background, scrimTop: getComputedStyle(el).getPropertyValue('--scrim-top').trim() }
  })()`)
  check(
    'choosing a background previews it on the canvas',
    previewed?.id === 'deep',
    JSON.stringify(previewed),
  )
  check(
    'the chosen background brings its own scrim',
    previewed?.scrimTop === '0.22',
    JSON.stringify(previewed),
  )

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
    'saving sends the chosen background',
    saved?.backgroundId === 'deep',
    JSON.stringify(saved),
  )
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

  // --- the palette asks for a key before it asks for work ---
  // The old flow let you type a description, press Enter, and only then said
  // "no API key" — the work was done and thrown away.
  await js(`window.reef.__setHasApiKey(false); true`)
  const paletteBtn = await centreOf('#new-app')
  if (paletteBtn) await clickAt(paletteBtn)
  await wait(400)

  const keyMode = await js(`(() => {
    const input = document.getElementById('prompt')
    const hint = document.getElementById('palette-hint')
    return {
      open: !document.getElementById('palette').hidden,
      type: input.type,
      placeholder: input.placeholder,
      hintShown: !hint.hidden,
      mentionsKey: hint.textContent.includes('Anthropic API key'),
      enterLabel: document.getElementById('palette-enter').textContent,
    }
  })()`)
  check('⌘K opens', keyMode?.open === true, JSON.stringify(keyMode))
  check(
    'with no key it asks for the key, not for a description',
    keyMode?.type === 'password' && keyMode.placeholder.startsWith('sk-ant'),
    JSON.stringify(keyMode),
  )
  check(
    'it explains why rather than erroring',
    keyMode?.hintShown === true && keyMode.mentionsKey === true,
    JSON.stringify(keyMode),
  )
  check("the ↵ hint says what Enter will do", keyMode?.enterLabel === 'save key', keyMode?.enterLabel)

  // Typing a key and pressing Enter should save it and continue, not build.
  await js(`document.getElementById('prompt').value = 'sk-ant-typed-in-the-palette'; true`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(500)

  const afterSave = await js(`(() => {
    const input = document.getElementById('prompt')
    return {
      saved: window.reef.__savedSettings()?.anthropicApiKey ?? null,
      type: input.type,
      placeholder: input.placeholder,
      value: input.value,
      enterLabel: document.getElementById('palette-enter').textContent,
      hintShown: !document.getElementById('palette-hint').hidden,
    }
  })()`)
  check(
    'Enter saves the key',
    afterSave?.saved === 'sk-ant-typed-in-the-palette',
    JSON.stringify(afterSave),
  )
  check(
    'and the same box becomes the build prompt',
    afterSave?.type === 'text' && afterSave.value === '' && afterSave.enterLabel === 'go',
    JSON.stringify(afterSave),
  )
  check('the key explainer goes away', afterSave?.hintShown === false)

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(250)

  // --- a build runs in the background, as a bubbling tile in the dock ---
  // The old palette was modal for the whole generation: esc refused to close
  // it and the desktop was unusable for minutes. Now Enter hands the build to
  // main and the palette becomes a live feed you can walk away from.
  const windowsBefore = await js(`document.querySelectorAll('.window').length`)

  if (paletteBtn) await clickAt(paletteBtn)
  await wait(300)
  await js(`document.getElementById('prompt').value = 'a tide clock for Santa Cruz'; true`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(400)

  const midBuild = await js(`(() => {
    const tile = document.querySelector('.dock-app.building')
    const r = tile?.getBoundingClientRect()
    const bubbles = tile ? getComputedStyle(tile.querySelector('.tile-bubbles i')).animationName : null
    return {
      tileVisible: Boolean(r && r.width > 0 && r.height > 0),
      bubblesAnimated: bubbles,
      paletteOpen: !document.getElementById('palette').hidden,
      liveLine: document.querySelector('#progress .bubbles') !== null,
      submitHidden: document.getElementById('palette-submit').hidden,
      escLabel: document.getElementById('palette-esc-label').textContent,
      prompts: window.reef.__generateCalls(),
    }
  })()`)
  check(
    'Enter starts a build and the dock grows a bubbling tile',
    midBuild?.tileVisible === true && midBuild.prompts?.length === 1,
    JSON.stringify(midBuild),
  )
  check(
    'the bubbles actually dance',
    midBuild?.bubblesAnimated === 'bubble-rise',
    `animation=${midBuild?.bubblesAnimated}`,
  )
  check(
    'the palette stays open as a live feed',
    midBuild?.paletteOpen === true && midBuild.liveLine === true,
    JSON.stringify(midBuild),
  )
  check(
    'the foot says esc continues in the background',
    midBuild?.submitHidden === true && /background/.test(midBuild?.escLabel ?? ''),
    JSON.stringify(midBuild),
  )

  // The feed narrates what the agent is doing, not just that it is busy.
  await js(`window.reef.__emitGenerating({ phase: 'thinking', tool: 'write_file', id: 'tide-clock' }); true`)
  await js(`window.reef.__emitGenerating({ phase: 'writing', file: 'index.html', id: 'tide-clock' }); true`)
  await wait(150)

  const narrated = await js(`(() => ({
    status: document.querySelector('#progress .status-text')?.textContent,
    wrote: [...document.querySelectorAll('#progress .line')].some((l) => l.textContent.includes('index.html')),
    tooltip: document.querySelector('.dock-app.building')?.title,
  }))()`)
  check(
    'the live line says what the agent just did',
    narrated?.wrote === true && Boolean(narrated.status),
    JSON.stringify(narrated),
  )
  check(
    'the dock tile tooltip carries the same status',
    (narrated?.tooltip ?? '').includes('index.html'),
    JSON.stringify(narrated),
  )

  // Photograph the building state — this is the moment the feature exists for.
  const shotDir = path.join(projectRoot, '.shots')
  await fs.mkdir(shotDir, { recursive: true })
  const image = await win.webContents.capturePage()
  await fs.writeFile(path.join(shotDir, 'building-state.png'), image.toPNG())

  // esc walks away without killing the build.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(250)

  const afterEsc = await js(`(() => ({
    paletteClosed: document.getElementById('palette').hidden,
    stillBuilding: document.querySelector('.dock-app.building') !== null,
  }))()`)
  check(
    'escape closes the palette while the build continues',
    afterEsc?.paletteClosed === true && afterEsc.stillBuilding === true,
    JSON.stringify(afterEsc),
  )

  // Clicking the bubbles reopens the narration, feed replayed.
  const buildingTile = await centreOf('.dock-app.building')
  if (buildingTile) await clickAt(buildingTile)
  await wait(250)

  const reopened = await js(`(() => ({
    open: !document.getElementById('palette').hidden,
    prompt: document.getElementById('prompt').value,
    locked: document.getElementById('prompt').disabled,
    replayed: [...document.querySelectorAll('#progress .line')].some((l) => l.textContent.includes('index.html')),
  }))()`)
  check(
    'clicking the bubbling tile reopens the live feed',
    reopened?.open === true && reopened.replayed === true && reopened.locked === true,
    JSON.stringify(reopened),
  )
  check(
    'the feed shows what is being built',
    reopened?.prompt === 'a tide clock for Santa Cruz',
    JSON.stringify(reopened),
  )

  // Walk away again, then let the build land: it must hatch quietly.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(200)
  await js(`window.reef.__emitGenerated({ ok: true, id: 'tide-clock', files: ['index.html'] }); true`)
  await wait(600)

  const landed = await js(`(() => {
    const buttons = [...document.querySelectorAll('.dock-app')]
    return {
      building: document.querySelector('.dock-app.building') !== null,
      hatched: buttons.some((b) => b.title === 'Tide Clock'),
      windows: document.querySelectorAll('.window').length,
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    }
  })()`)
  check(
    'the bubbles hatch into the real app tile',
    landed?.building === false && landed.hatched === true,
    JSON.stringify(landed),
  )
  check(
    'a background landing announces itself without stealing focus',
    landed?.windows === windowsBefore && /Tide Clock/.test(landed?.toast ?? ''),
    JSON.stringify(landed),
  )

  // --- clicking a back window's content brings it to the front ---
  // The window's own mousedown listener never hears a click that lands in the
  // app's iframe — the event dies inside the frame's document. So clicking the
  // visible part of a back window did nothing, exactly like a click that
  // "works" in tests driven by element.click(). Real pointer input only.
  const dock1 = await centreOf('#dock-apps .dock-app:nth-of-type(1)')
  const dock2 = await centreOf('#dock-apps .dock-app:nth-of-type(2)')
  if (dock1) await clickAt(dock1)
  if (dock2) await clickAt(dock2)

  // Deterministic overlap: A back-left, B in front covering A's right side.
  await js(`(() => {
    const wins = [...document.querySelectorAll('.window')]
    const a = wins.find((w) => w.querySelector('.name').textContent === 'Probe')
    const b = wins.find((w) => w.querySelector('.name').textContent === 'Feed Reader')
    Object.assign(a.style, { left: '80px', top: '80px', width: '700px', height: '520px' })
    Object.assign(b.style, { left: '360px', top: '240px', width: '700px', height: '460px' })
    return true
  })()`)
  await wait(120)

  const nameAt = (x, y) =>
    js(`document.elementFromPoint(${x}, ${y})?.closest('.window')?.querySelector('.name').textContent ?? null`)

  const beforeRaise = await js(`(() => {
    const wins = [...document.querySelectorAll('.window')]
    const of = (name) => wins.find((w) => w.querySelector('.name').textContent === name)
    return {
      probeFocused: of('Probe').classList.contains('focused'),
      feedFocused: of('Feed Reader').classList.contains('focused'),
    }
  })()`)
  check(
    'the front window holds focus before the click',
    beforeRaise?.feedFocused === true && beforeRaise.probeFocused === false,
    JSON.stringify(beforeRaise),
  )

  // (120, 320) is inside Probe's stage — pure iframe territory — and left of
  // Feed Reader entirely.
  await clickAt({ x: 120, y: 320 })

  const afterRaise = await js(`(() => {
    const wins = [...document.querySelectorAll('.window')]
    const of = (name) => wins.find((w) => w.querySelector('.name').textContent === name)
    return {
      probeFocused: of('Probe').classList.contains('focused'),
      zProbe: Number(of('Probe').style.zIndex),
      zFeed: Number(of('Feed Reader').style.zIndex),
    }
  })()`)
  check(
    'clicking a back window’s content focuses it',
    afterRaise?.probeFocused === true,
    JSON.stringify(afterRaise),
  )
  check(
    'and raises it above the old front window',
    afterRaise && afterRaise.zProbe > afterRaise.zFeed,
    JSON.stringify(afterRaise),
  )
  // The effect a user sees: where the two overlap, Probe now paints on top.
  const overlapWinner = await nameAt(480, 300)
  check('the raised window paints over the overlap', overlapWinner === 'Probe', String(overlapWinner))

  // The catcher must not tax the focused window: once Probe is front, its
  // frame gets the pointer again (the catcher only exists while unfocused).
  const catcherGone = await js(`(() => {
    const probe = [...document.querySelectorAll('.window')]
      .find((w) => w.querySelector('.name').textContent === 'Probe')
    const r = probe.querySelector('.catcher')?.getBoundingClientRect()
    return !r || (r.width === 0 && r.height === 0)
  })()`)
  check('the focused window’s catcher gets out of the way', catcherGone === true)

  // --- the green bubble fills the desktop, and gives it back ---
  const beforeMax = await js(`(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.name').textContent === 'Probe')
    const r = w.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })()`)

  const expandPoint = await centreOf('.window.focused .titlebar button.expand')
  check('a window carries an expand bubble', Boolean(expandPoint))
  if (expandPoint) await clickAt(expandPoint)
  await wait(200)

  const maxed = await js(`(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.name').textContent === 'Probe')
    const r = w.getBoundingClientRect()
    const canvas = document.getElementById('canvas').getBoundingClientRect()
    const resize = w.querySelector('.resize')?.getBoundingClientRect()
    return {
      fillsWidth: Math.abs(r.width - canvas.width) < 3,
      fillsHeight: r.height > canvas.height - 40,
      resizable: Boolean(resize && resize.width > 0),
    }
  })()`)
  check(
    'expand fills the desktop',
    maxed?.fillsWidth === true && maxed.fillsHeight === true,
    JSON.stringify(maxed),
  )
  check('a maximized window hides its resize handle', maxed?.resizable === false, JSON.stringify(maxed))

  const expandAgain = await centreOf('.window.focused .titlebar button.expand')
  if (expandAgain) await clickAt(expandAgain)
  await wait(200)

  const unmaxed = await js(`(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.name').textContent === 'Probe')
    const r = w.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })()`)
  check(
    'a second click gives the old geometry back exactly',
    unmaxed &&
      beforeMax &&
      ['left', 'top', 'width', 'height'].every((k) => Math.abs(unmaxed[k] - beforeMax[k]) < 2),
    `${JSON.stringify(beforeMax)} -> ${JSON.stringify(unmaxed)}`,
  )

  // Double-clicking the titlebar is the other way in.
  const titlebarPoint = await js(`(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.name').textContent === 'Probe')
    const r = w.querySelector('.titlebar').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (titlebarPoint) {
    // A DOM dblclick only fires after a full two-click sequence — the second
    // click carrying clickCount:2. One down/up pair never triggers it.
    win.webContents.sendInputEvent({ type: 'mouseDown', ...titlebarPoint, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...titlebarPoint, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...titlebarPoint, button: 'left', clickCount: 2 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...titlebarPoint, button: 'left', clickCount: 2 })
    await wait(250)
  }
  const dblMaxed = await js(`(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.name').textContent === 'Probe')
    const canvas = document.getElementById('canvas').getBoundingClientRect()
    return Math.abs(w.getBoundingClientRect().width - canvas.width) < 3
  })()`)
  check('double-clicking the titlebar maximizes too', dblMaxed === true, `filled=${dblMaxed}`)

  // --- ⌘K routes: a question gets an answer, not a build ---
  // "check my emails" is not an app description. Before the router it went
  // straight into a minutes-long build of a mock inbox; now main answers in
  // the palette and nothing expensive runs.
  const pressEnter = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }

  const routePaletteBtn = await centreOf('#new-app')
  if (routePaletteBtn) await clickAt(routePaletteBtn)
  await wait(300)
  await js(`document.getElementById('prompt').value = 'can you check my emails?'; true`)
  pressEnter()
  await wait(400)

  const answered = await js(`(() => {
    const reply = document.querySelector('#progress .line.reply')
    const input = document.getElementById('prompt')
    return {
      paletteOpen: !document.getElementById('palette').hidden,
      reply: reply?.textContent ?? null,
      replyVisible: Boolean(reply && reply.getBoundingClientRect().height > 0),
      editable: !input.disabled,
      kept: input.value,
      building: document.querySelector('.dock-app.building') !== null,
    }
  })()`)
  check(
    'a question is answered in the palette, visibly',
    answered?.paletteOpen === true && answered.replyVisible === true && /mail/.test(answered.reply ?? ''),
    JSON.stringify(answered),
  )
  check(
    'the prompt stays put and editable for a rephrase',
    answered?.editable === true && answered.kept === 'can you check my emails?',
    JSON.stringify(answered),
  )
  check('and nothing started building', answered?.building === false, JSON.stringify(answered))

  // --- ⌘K routes: naming an installed app opens it instead of building ---
  await js(`document.getElementById('prompt').value = 'open doodle'; true`)
  pressEnter()
  await wait(500)

  const openedByRoute = await js(`(() => ({
    paletteClosed: document.getElementById('palette').hidden,
    doodleOpen: [...document.querySelectorAll('.window')]
      .some((w) => w.querySelector('.name').textContent === 'Doodle'),
    building: document.querySelector('.dock-app.building') !== null,
  }))()`)
  check(
    'naming an installed app opens it, palette dismissed',
    openedByRoute?.paletteClosed === true && openedByRoute.doodleOpen === true,
    JSON.stringify(openedByRoute),
  )
  check('opening built nothing either', openedByRoute?.building === false, JSON.stringify(openedByRoute))

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
