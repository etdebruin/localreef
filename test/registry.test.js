import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readApp, scanApps } from '../src/core/registry.js'

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ld-reg-'))
}

async function makeApp(root, name, files) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(dir, file)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, body)
  }
  return dir
}

test('readApp', async (t) => {
  const root = await tmp()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await t.test('reads a bare static app with no manifest', async () => {
    const dir = await makeApp(root, 'notes', { 'index.html': '<h1>hi</h1>' })
    const app = await readApp(dir)
    assert.equal(app.id, 'notes')
    assert.equal(app.name, 'Notes')
    assert.equal(app.type, 'static')
    assert.equal(app.root, dir)
    assert.equal(app.dir, dir)
    assert.equal(app.error, undefined)
  })

  await t.test('reads a node app from package.json', async () => {
    const dir = await makeApp(root, 'chart', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    })
    const app = await readApp(dir)
    assert.equal(app.type, 'server')
    assert.equal(app.run, 'npm run dev')
  })

  await t.test('picks up the package manager from the lockfile', async () => {
    const dir = await makeApp(root, 'pnpmapp', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'pnpm-lock.yaml': '',
    })
    const app = await readApp(dir)
    assert.equal(app.run, 'pnpm run dev')
  })

  await t.test('desktop.json overrides inference', async () => {
    const dir = await makeApp(root, 'feed', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'desktop.json': JSON.stringify({ name: 'Feed Reader', icon: '📡', keepAlive: -1 }),
    })
    const app = await readApp(dir)
    assert.equal(app.name, 'Feed Reader')
    assert.equal(app.icon, '📡')
    assert.equal(app.keepAlive, -1)
  })

  await t.test('resolves a static root to an absolute path', async () => {
    const dir = await makeApp(root, 'built', {
      'index.html': 'x',
      'package.json': JSON.stringify({ name: 'built' }),
      'dist/index.html': 'built',
    })
    const app = await readApp(dir)
    assert.equal(app.type, 'static')
    assert.equal(app.root, path.join(dir, 'dist'))
  })

  await t.test('reports an unrecognisable folder instead of throwing', async () => {
    const dir = await makeApp(root, 'mystery', { 'README.md': 'nothing here' })
    const app = await readApp(dir)
    assert.equal(app.type, null)
    assert.match(app.error, /index\.html/)
  })

  await t.test('survives malformed package.json', async () => {
    const dir = await makeApp(root, 'broken', { 'package.json': '{ not json' })
    const app = await readApp(dir)
    assert.ok(app.error, 'expected an error, got none')
  })

  await t.test('survives malformed desktop.json', async () => {
    const dir = await makeApp(root, 'broken2', {
      'index.html': 'x',
      'desktop.json': '{ nope',
    })
    const app = await readApp(dir)
    assert.ok(app.error, 'expected an error, got none')
  })
})

test('scanApps', async (t) => {
  const root = await tmp()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await makeApp(root, 'notes', { 'index.html': 'x' })
  await makeApp(root, 'chart', { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })
  await makeApp(root, '.hidden', { 'index.html': 'x' })
  await fs.writeFile(path.join(root, 'loose-file.txt'), 'not an app')

  await t.test('finds every app folder, sorted by id', async () => {
    const apps = await scanApps(root)
    assert.deepEqual(
      apps.map((a) => a.id),
      ['chart', 'notes'],
    )
  })

  await t.test('ignores dotfolders and loose files', async () => {
    const apps = await scanApps(root)
    assert.equal(apps.find((a) => a.id === '.hidden'), undefined)
    assert.equal(apps.find((a) => a.id === 'loose-file.txt'), undefined)
  })

  await t.test('returns an empty list for a missing directory', async () => {
    assert.deepEqual(await scanApps(path.join(root, 'nope')), [])
  })
})
