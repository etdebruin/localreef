import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readApp, scanApps, adoptApp } from '../src/core/registry.js'

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

  await t.test('reef.json overrides inference', async () => {
    const dir = await makeApp(root, 'feed', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'reef.json': JSON.stringify({ name: 'Feed Reader', icon: '📡', keepAlive: -1 }),
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

  await t.test('survives malformed reef.json', async () => {
    const dir = await makeApp(root, 'broken2', {
      'index.html': 'x',
      'reef.json': '{ nope',
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

// A curated folder (apps/, userData/apps/) is one where everything is an app,
// so inference alone is safe. A folder the user points us at — ~/Code — is
// not: it is full of libraries, forks and scratch repos. There, reef.json
// is the opt-in marker. Its *contents* stay optional; an empty {} is enough.
test('scanApps with requireManifest', async (t) => {
  const root = await tmp()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await makeApp(root, 'notes', { 'index.html': 'x', 'reef.json': '{}' })
  await makeApp(root, 'chart', {
    'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    'reef.json': JSON.stringify({ icon: '📈' }),
  })
  await makeApp(root, 'some-lib', { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })
  await makeApp(root, 'scratch', { 'index.html': 'x' })
  await makeApp(root, 'node_modules', { 'package.json': '{}' })

  await t.test('includes only folders that opted in with a manifest', async () => {
    const apps = await scanApps(root, { requireManifest: true })
    assert.deepEqual(
      apps.map((a) => a.id),
      ['chart', 'notes'],
    )
  })

  await t.test('an empty manifest is enough to opt in, inference still fills it', async () => {
    const apps = await scanApps(root, { requireManifest: true })
    const notes = apps.find((a) => a.id === 'notes')
    assert.equal(notes.type, 'static')
    assert.equal(notes.error, undefined)
  })

  await t.test('a runnable folder without a manifest stays off the desktop', async () => {
    const apps = await scanApps(root, { requireManifest: true })
    assert.equal(apps.find((a) => a.id === 'some-lib'), undefined)
    assert.equal(apps.find((a) => a.id === 'scratch'), undefined)
    assert.equal(apps.find((a) => a.id === 'node_modules'), undefined)
  })

  await t.test('a folder that opted in with a broken manifest still appears', async () => {
    // It asked to be here, so it gets a broken icon that says why — never a
    // silent omission.
    const dir = await makeApp(root, 'busted', { 'index.html': 'x', 'reef.json': '{ not json' })
    const apps = await scanApps(root, { requireManifest: true })
    const busted = apps.find((a) => a.id === 'busted')

    assert.ok(busted, 'expected the opted-in folder to be listed')
    assert.match(busted.error, /reef\.json/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('without the option every folder is still scanned', async () => {
    const apps = await scanApps(root)
    assert.ok(apps.find((a) => a.id === 'some-lib'), 'curated scans keep inferring')
  })
})

test('adoptApp', async (t) => {
  const root = await tmp()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await t.test('copies a bundled app into the generated root', async () => {
    const src = await makeApp(root, 'clock-src', {
      'reef.json': JSON.stringify({ name: 'Clock' }),
      'server.js': 'code',
      'lib/util.js': 'nested',
    })
    const destRoot = path.join(root, 'generated-a')

    const result = await adoptApp({ srcDir: src, destRoot, id: 'clock' })

    assert.equal(result.ok, true)
    assert.equal(result.dir, path.join(destRoot, 'clock'))
    assert.equal(await fs.readFile(path.join(result.dir, 'server.js'), 'utf8'), 'code')
    assert.equal(await fs.readFile(path.join(result.dir, 'lib/util.js'), 'utf8'), 'nested')
    // The original is untouched — adoption copies, never moves.
    assert.equal(await fs.readFile(path.join(src, 'server.js'), 'utf8'), 'code')
  })

  await t.test('refuses to overwrite an existing folder', async () => {
    const src = await makeApp(root, 'clash-src', { 'index.html': 'new' })
    const destRoot = path.join(root, 'generated-b')
    await makeApp(destRoot, 'clash', { 'index.html': 'precious user data' })

    const result = await adoptApp({ srcDir: src, destRoot, id: 'clash' })

    assert.equal(result.ok, false)
    assert.match(result.error, /already exists/)
    const kept = await fs.readFile(path.join(destRoot, 'clash/index.html'), 'utf8')
    assert.equal(kept, 'precious user data')
  })

  await t.test('leaves node_modules and dotfiles behind', async () => {
    const src = await makeApp(root, 'heavy-src', {
      'index.html': 'x',
      'node_modules/left-pad/index.js': 'pad',
      '.git/HEAD': 'ref',
      '.DS_Store': 'junk',
    })
    const destRoot = path.join(root, 'generated-c')

    const result = await adoptApp({ srcDir: src, destRoot, id: 'heavy' })

    assert.equal(result.ok, true)
    await assert.rejects(fs.access(path.join(result.dir, 'node_modules')))
    await assert.rejects(fs.access(path.join(result.dir, '.git')))
    await assert.rejects(fs.access(path.join(result.dir, '.DS_Store')))
    assert.equal(await fs.readFile(path.join(result.dir, 'index.html'), 'utf8'), 'x')
  })

  await t.test('a vanished source is an error, not a crash', async () => {
    const result = await adoptApp({
      srcDir: path.join(root, 'no-such-folder'),
      destRoot: path.join(root, 'generated-d'),
      id: 'ghost',
    })
    assert.equal(result.ok, false)
    assert.ok(result.error)
  })
})
