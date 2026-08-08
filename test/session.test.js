import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSessionStore } from '../src/core/session.js'

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ld-session-'))
}

const WIN = { id: 'notes', left: 120, top: 90, width: 800, height: 540, minimized: false }

test('createSessionStore', async (t) => {
  await t.test('returns an empty session when there is no file yet', async () => {
    const dir = await scratch()
    const store = createSessionStore(path.join(dir, 'session.json'))

    assert.deepEqual(await store.read(), { main: null, windows: [] })
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('persists windows across instances', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')

    await createSessionStore(file).update({ windows: [WIN] })
    assert.deepEqual((await createSessionStore(file).read()).windows, [WIN])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('persists the main window bounds', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const bounds = { x: 40, y: 30, width: 1400, height: 900 }

    await createSessionStore(file).update({ main: bounds })
    assert.deepEqual((await createSessionStore(file).read()).main, bounds)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('update merges rather than replacing', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const store = createSessionStore(file)

    await store.update({ main: { x: 0, y: 0, width: 1280, height: 820 } })
    await store.update({ windows: [WIN] })

    const session = await store.read()
    assert.equal(session.main.width, 1280)
    assert.equal(session.windows.length, 1)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('preserves window order — it is the z-order', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const store = createSessionStore(file)

    await store.update({ windows: [{ ...WIN, id: 'back' }, { ...WIN, id: 'front' }] })
    assert.deepEqual(
      (await store.read()).windows.map((w) => w.id),
      ['back', 'front'],
    )
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('drops malformed window entries rather than restoring garbage', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const store = createSessionStore(file)

    await store.update({
      windows: [
        WIN,
        { id: '', left: 1, top: 1, width: 1, height: 1 },
        { id: 'no-geometry' },
        { id: 'nan', left: NaN, top: 0, width: 800, height: 500 },
        'not even an object',
      ],
    })

    assert.deepEqual((await store.read()).windows.map((w) => w.id), ['notes'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('coerces minimized to a boolean and rounds geometry', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const store = createSessionStore(file)

    await store.update({
      windows: [{ id: 'notes', left: 10.6, top: 9.2, width: 800.4, height: 540.5, minimized: undefined }],
    })

    assert.deepEqual((await store.read()).windows, [
      { id: 'notes', left: 11, top: 9, width: 800, height: 541, minimized: false },
    ])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('survives a corrupt session file', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    await fs.writeFile(file, '{ not json')

    // Same failure posture as settings and links: an unreadable session must
    // never stop the desktop from starting — it just starts empty.
    assert.deepEqual(await createSessionStore(file).read(), { main: null, windows: [] })
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('rejects malformed main bounds rather than storing them', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'session.json')
    const store = createSessionStore(file)

    await store.update({ main: { x: 0, y: 0, width: 'wide', height: 900 } })
    assert.equal((await store.read()).main, null)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
