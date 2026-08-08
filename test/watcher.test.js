import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createWatcher } from '../src/main/watcher.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// FSEvents delivers a burst in clumps tens of milliseconds apart, so the test
// debounce has to be wide enough to bridge a clump gap, and the settle wait
// long enough for the trailing edge to fire.
const DEBOUNCE_MS = 75
const SETTLE_MS = 400

async function appDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-watch-'))
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>')
  return dir
}

// A fresh watch swallows FSEvents' start-up replay for its settle window —
// writes only count as changes once that window has passed.
async function watchSettled(watcher, id, dir) {
  watcher.watch(id, dir)
  await sleep(DEBOUNCE_MS + 50)
}

test('createWatcher', async (t) => {
  const dirs = []
  const watchers = []
  const make = (onChange) => {
    const w = createWatcher({ onChange, debounceMs: DEBOUNCE_MS })
    watchers.push(w)
    return w
  }
  t.after(async () => {
    for (const w of watchers) w.close()
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  })

  await t.test('a write fires one change for the app', async () => {
    const dir = await appDir()
    dirs.push(dir)
    const seen = []
    const watcher = make((id) => seen.push(id))

    await watchSettled(watcher, 'timer', dir)
    await fs.writeFile(path.join(dir, 'index.html'), '<h1>edited</h1>')
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, ['timer'])
  })

  await t.test('a burst of writes collapses to one change', async () => {
    const dir = await appDir()
    dirs.push(dir)
    const seen = []
    const watcher = make((id) => seen.push(id))

    await watchSettled(watcher, 'burst', dir)
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(dir, `file-${i}.js`), String(i))
    }
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, ['burst'])
  })

  await t.test('ignores dotfiles and node_modules', async () => {
    const dir = await appDir()
    dirs.push(dir)
    await fs.mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true })
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    const seen = []
    const watcher = make((id) => seen.push(id))

    await watchSettled(watcher, 'quiet', dir)
    await fs.writeFile(path.join(dir, '.DS_Store'), 'x')
    await fs.writeFile(path.join(dir, '.git/HEAD'), 'ref')
    await fs.writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'x')
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, [])
  })

  await t.test('unwatch silences an app', async () => {
    const dir = await appDir()
    dirs.push(dir)
    const seen = []
    const watcher = make((id) => seen.push(id))

    watcher.watch('gone', dir)
    watcher.unwatch('gone')
    await fs.writeFile(path.join(dir, 'index.html'), 'y')
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, [])
  })

  await t.test('watching the same id again does not double-fire', async () => {
    const dir = await appDir()
    dirs.push(dir)
    const seen = []
    const watcher = make((id) => seen.push(id))

    watcher.watch('twice', dir)
    await watchSettled(watcher, 'twice', dir)
    await fs.writeFile(path.join(dir, 'index.html'), 'y')
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, ['twice'])
  })

  await t.test('a missing directory is a no-op, not a crash', async () => {
    const watcher = make(() => {})
    watcher.watch('ghost', path.join(os.tmpdir(), 'ld-watch-definitely-missing'))
    await sleep(SETTLE_MS)
    // Reaching this line without throwing is the assertion.
    assert.ok(true)
  })

  await t.test('survives the watched directory being deleted', async () => {
    const dir = await appDir()
    const seen = []
    const watcher = make((id) => seen.push(id))

    await watchSettled(watcher, 'doomed', dir)
    await fs.rm(dir, { recursive: true, force: true })
    await sleep(SETTLE_MS)

    // The delete may or may not surface as a change event depending on the
    // platform; the contract is only that nothing throws and later writes to
    // other apps still work.
    const dir2 = await appDir()
    dirs.push(dir2)
    await watchSettled(watcher, 'alive', dir2)
    await fs.writeFile(path.join(dir2, 'index.html'), 'y')
    await sleep(SETTLE_MS)
    assert.ok(seen.includes('alive'))
  })

  await t.test('close silences everything', async () => {
    const dir = await appDir()
    dirs.push(dir)
    const seen = []
    const watcher = make((id) => seen.push(id))

    watcher.watch('a', dir)
    watcher.close()
    await fs.writeFile(path.join(dir, 'index.html'), 'y')
    await sleep(SETTLE_MS)

    assert.deepEqual(seen, [])
  })
})
