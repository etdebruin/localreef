import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLinkStore } from '../src/core/links.js'

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ld-links-'))
}

test('createLinkStore', async (t) => {
  await t.test('starts empty when there is no file yet', async () => {
    const dir = await scratch()
    const store = createLinkStore(path.join(dir, 'links.json'))
    assert.deepEqual(await store.list(), [])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('adds a folder and persists it across instances', async () => {
    const dir = await scratch()
    const target = path.join(dir, 'project')
    await fs.mkdir(target)
    const file = path.join(dir, 'links.json')

    const added = await createLinkStore(file).add(target)
    assert.equal(added.ok, true)

    // A fresh store reads the same list back off disk.
    assert.deepEqual(await createLinkStore(file).list(), [target])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('refuses a path that is not a directory', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'a-file.txt')
    await fs.writeFile(file, 'x')

    const store = createLinkStore(path.join(dir, 'links.json'))
    const result = await store.add(file)
    assert.equal(result.ok, false)
    assert.match(result.error, /folder|director/i)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('refuses a folder that does not exist', async () => {
    const dir = await scratch()
    const store = createLinkStore(path.join(dir, 'links.json'))
    const result = await store.add(path.join(dir, 'nope'))
    assert.equal(result.ok, false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('adding the same folder twice is a no-op', async () => {
    const dir = await scratch()
    const target = path.join(dir, 'project')
    await fs.mkdir(target)
    const store = createLinkStore(path.join(dir, 'links.json'))

    await store.add(target)
    await store.add(target)
    assert.deepEqual(await store.list(), [target])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('normalises a trailing slash to the same entry', async () => {
    const dir = await scratch()
    const target = path.join(dir, 'project')
    await fs.mkdir(target)
    const store = createLinkStore(path.join(dir, 'links.json'))

    await store.add(target)
    await store.add(`${target}/`)
    assert.deepEqual(await store.list(), [target])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('removes a folder', async () => {
    const dir = await scratch()
    const target = path.join(dir, 'project')
    await fs.mkdir(target)
    const store = createLinkStore(path.join(dir, 'links.json'))

    await store.add(target)
    await store.remove(target)
    assert.deepEqual(await store.list(), [])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('drops entries whose folder has since disappeared', async () => {
    const dir = await scratch()
    const target = path.join(dir, 'project')
    await fs.mkdir(target)
    const file = path.join(dir, 'links.json')

    await createLinkStore(file).add(target)
    await fs.rm(target, { recursive: true, force: true })

    assert.deepEqual(await createLinkStore(file).list(), [])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('survives a corrupt links file', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'links.json')
    await fs.writeFile(file, '{ not json')

    assert.deepEqual(await createLinkStore(file).list(), [])
    await fs.rm(dir, { recursive: true, force: true })
  })
})
