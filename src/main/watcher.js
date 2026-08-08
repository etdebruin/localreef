/**
 * Watch open apps' folders so an edit — from the ⌘K chat or the user's own
 * editor — reloads the frame without anyone pressing anything.
 *
 * One watcher per open static app, started at launch and stopped with the
 * window. Events are debounced per app on the trailing edge: the agent writes
 * several files per turn and the desktop wants one reload, not one per file.
 *
 * `fs.watch` with `recursive: true` is reliable on macOS (FSEvents), which is
 * the platform this app targets; recursive watching also works on Node ≥ 20
 * Linux. Server apps are never watched — dev servers own their own reload
 * (Vite HMR rides the gateway's WebSocket relay), and watching them would
 * double-fire.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Changes under these never mean "the app changed". */
function ignorable(file) {
  // macOS can coalesce a burst into an event with no filename. Real writes to
  // real files arrive with names alongside it, so the anonymous event carries
  // no extra information — and reacting to it turns a .DS_Store write into a
  // frame reload.
  if (!file) return true
  return String(file)
    .split('/')
    .some((segment) => segment.startsWith('.') || segment === 'node_modules')
}

export function createWatcher({ onChange = () => {}, debounceMs = 150, settleMs = debounceMs } = {}) {
  /** id -> { watcher, timer, armAt } */
  const watched = new Map()

  function unwatch(id) {
    const entry = watched.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.watcher.close()
    watched.delete(id)
  }

  function watch(id, dir) {
    unwatch(id)

    // FSEvents replays a beat of pre-watch history when a stream opens — the
    // folder's own creation, files written just before launch — and reports
    // the watched directory itself by its bare name. Neither is a change, and
    // reacting would reload every frame the moment it opens. Events inside
    // the settle window are that replay; the dir's own name never identifies
    // a file a relative path could point at.
    const armAt = Date.now() + settleMs
    const self = path.basename(dir)

    let watcher
    try {
      watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
        if (Date.now() < armAt) return
        if (file === self || ignorable(file)) return
        const entry = watched.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => onChange(id), debounceMs)
      })
    } catch {
      // The folder vanished between launch and here. Nothing to watch is not
      // an error — the app simply won't hot-reload.
      return
    }

    // The watched directory can be deleted while we hold it (the OS tears the
    // watcher down with an error). Fold the watcher rather than crashing the
    // desktop over a folder that no longer exists.
    watcher.on('error', () => unwatch(id))

    watched.set(id, { watcher, timer: null })
  }

  function close() {
    for (const id of [...watched.keys()]) unwatch(id)
  }

  return { watch, unwatch, close }
}
