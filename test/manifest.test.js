import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveManifest } from '../src/core/manifest.js'

const inferredNode = { type: 'node', run: 'npm run dev', root: '.' }
const inferredStatic = { type: 'static', root: 'dist' }

test('resolveManifest', async (t) => {
  await t.test('derives an id and a title-cased name from the folder', () => {
    const got = resolveManifest({ folderName: 'feed-reader', inferred: inferredNode })
    assert.equal(got.id, 'feed-reader')
    assert.equal(got.name, 'Feed Reader')
  })

  await t.test('lowercases the id but keeps the display name readable', () => {
    const got = resolveManifest({ folderName: 'Notes', inferred: inferredStatic })
    assert.equal(got.id, 'notes')
    assert.equal(got.name, 'Notes')
  })

  await t.test('an explicit name wins', () => {
    const got = resolveManifest({
      folderName: 'feed-reader',
      inferred: inferredNode,
      manifest: { name: 'Reader' },
    })
    assert.equal(got.name, 'Reader')
  })

  await t.test('carries inference through when the manifest is silent', () => {
    const got = resolveManifest({ folderName: 'chart', inferred: inferredNode })
    assert.equal(got.type, 'server')
    assert.equal(got.run, 'npm run dev')
  })

  await t.test('an explicit type overrides inference', () => {
    const got = resolveManifest({
      folderName: 'chart',
      inferred: inferredNode,
      manifest: { type: 'static', root: 'public' },
    })
    assert.equal(got.type, 'static')
    assert.equal(got.root, 'public')
  })

  await t.test('an explicit run overrides inference', () => {
    const got = resolveManifest({
      folderName: 'api',
      inferred: inferredNode,
      manifest: { run: 'node server.js' },
    })
    assert.equal(got.run, 'node server.js')
  })

  await t.test('applies lifecycle and window defaults', () => {
    const got = resolveManifest({ folderName: 'notes', inferred: inferredStatic })
    assert.equal(got.keepAlive, 300)
    assert.deepEqual(got.window, { width: 800, height: 600, resizable: true })
    assert.deepEqual(got.permissions, [])
    assert.deepEqual(got.intents, [])
    assert.deepEqual(got.env, {})
  })

  await t.test('keepAlive accepts the never-stop sentinel', () => {
    const got = resolveManifest({
      folderName: 'feed',
      inferred: inferredNode,
      manifest: { keepAlive: -1 },
    })
    assert.equal(got.keepAlive, -1)
  })

  await t.test('keepAlive accepts zero rather than falling back to the default', () => {
    const got = resolveManifest({
      folderName: 'feed',
      inferred: inferredNode,
      manifest: { keepAlive: 0 },
    })
    assert.equal(got.keepAlive, 0)
  })

  await t.test('window options merge field by field', () => {
    const got = resolveManifest({
      folderName: 'notes',
      inferred: inferredStatic,
      manifest: { window: { width: 720 } },
    })
    assert.deepEqual(got.window, { width: 720, height: 600, resizable: true })
  })

  await t.test('passes permissions and intents through', () => {
    const got = resolveManifest({
      folderName: 'notes',
      inferred: inferredStatic,
      manifest: { permissions: ['storage', 'ai'], intents: ['add:link'] },
    })
    assert.deepEqual(got.permissions, ['storage', 'ai'])
    assert.deepEqual(got.intents, ['add:link'])
  })

  await t.test('accepts "server" as the runtime-neutral type', () => {
    const got = resolveManifest({
      folderName: 'api',
      inferred: inferredNode,
      manifest: { type: 'server', run: 'uv run uvicorn app:main' },
    })
    assert.equal(got.type, 'server')
    assert.equal(got.run, 'uv run uvicorn app:main')
  })

  // "node" was the original name; anything non-static is really just a server.
  await t.test('normalises the legacy "node" type to "server"', () => {
    assert.equal(resolveManifest({ folderName: 'x', inferred: inferredNode }).type, 'server')
    assert.equal(
      resolveManifest({ folderName: 'x', inferred: {}, manifest: { type: 'node', run: 'x' } }).type,
      'server',
    )
  })

  await t.test('static stays static', () => {
    assert.equal(resolveManifest({ folderName: 'x', inferred: inferredStatic }).type, 'static')
  })

  await t.test('carries a declared fixed port for servers that ignore PORT', () => {
    const got = resolveManifest({
      folderName: 'api',
      inferred: inferredNode,
      manifest: { port: 8765 },
    })
    assert.equal(got.port, 8765)
  })

  await t.test('port is null when not declared', () => {
    assert.equal(resolveManifest({ folderName: 'api', inferred: inferredNode }).port, null)
  })

  await t.test('ignores unknown manifest fields', () => {
    const got = resolveManifest({
      folderName: 'notes',
      inferred: inferredStatic,
      manifest: { colour: 'blue' },
    })
    assert.equal(got.colour, undefined)
    assert.equal(got.id, 'notes')
  })
})
