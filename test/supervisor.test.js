import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSupervisor } from '../src/main/supervisor.js'

async function appDir(name, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ld-sup-${name}-`))
  for (const [file, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), body)
  }
  return dir
}

// A server that ignores PORT and announces its own, the way Vite does.
const IGNORES_PORT = `
const http = require('http')
const s = http.createServer((_, res) => res.end('ok'))
s.listen(0, '127.0.0.1', () => {
  console.log('  ➜  Local:   http://localhost:' + s.address().port + '/')
})
`

// A well-behaved server that honours PORT, the way Next.js does.
const HONOURS_PORT = `
const http = require('http')
const s = http.createServer((_, res) => res.end('ok'))
s.listen(process.env.PORT, '127.0.0.1', () => console.log('up'))
`

// Binds IPv6 loopback only — what any server listening on "localhost" does on
// a modern macOS, Vite included.
const IPV6_ONLY = `
const http = require('http')
const s = http.createServer((_, res) => res.end('ok'))
s.listen(0, '::1', () => {
  console.log('  ➜  Local:   http://localhost:' + s.address().port + '/')
})
`

const CRASHES = `
console.error('boom: could not find module "nope"')
process.exit(1)
`

// Reports the key it was (or was not) handed, so the tests can ask the child
// itself rather than trusting whatever object we composed for spawn().
const ECHOES_KEY = `
const http = require('http')
const s = http.createServer((_, res) => res.end(process.env.ANTHROPIC_API_KEY ?? 'ABSENT'))
s.listen(process.env.PORT, '127.0.0.1', () => console.log('up'))
`

async function keySeenBy(state) {
  const res = await fetch(`http://127.0.0.1:${state.port}/`)
  return res.text()
}

test('supervisor', async (t) => {
  const dirs = []
  const supervisor = createSupervisor({ readyTimeoutMs: 15000 })
  t.after(async () => {
    await supervisor.stopAll()
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  })

  await t.test('static apps are ready without spawning anything', async () => {
    const state = await supervisor.ensureStarted({ id: 'notes', type: 'static', root: '/tmp' })
    assert.equal(state.status, 'ready')
    assert.equal(state.port, null)
  })

  await t.test('adopts the port a server prints when it ignores PORT', async () => {
    const dir = await appDir('vite', { 'server.js': IGNORES_PORT })
    dirs.push(dir)
    const state = await supervisor.ensureStarted({
      id: 'vitelike',
      type: 'server',
      dir,
      run: 'node server.js',
    })
    assert.equal(state.status, 'ready')
    assert.ok(state.port > 0, `expected a port, got ${state.port}`)
  })

  await t.test('uses the injected PORT when the server honours it', async () => {
    const dir = await appDir('next', { 'server.js': HONOURS_PORT })
    dirs.push(dir)
    const state = await supervisor.ensureStarted({
      id: 'nextlike',
      type: 'server',
      dir,
      run: 'node server.js',
    })
    assert.equal(state.status, 'ready')
    assert.ok(state.port > 0)
  })

  await t.test('reaches a server bound to IPv6 loopback only', async () => {
    const dir = await appDir('ipv6', { 'server.js': IPV6_ONLY })
    dirs.push(dir)
    const state = await supervisor.ensureStarted({
      id: 'ipv6only',
      type: 'server',
      dir,
      run: 'node server.js',
    })
    assert.equal(state.status, 'ready', state.error ?? '')
    assert.ok(state.port > 0)
    // The gateway has to know which family to proxy to.
    assert.equal(state.host, '::1')
  })

  await t.test('records the IPv4 host for a server bound to 127.0.0.1', async () => {
    const dir = await appDir('ipv4', { 'server.js': HONOURS_PORT })
    dirs.push(dir)
    const state = await supervisor.ensureStarted({
      id: 'ipv4only',
      type: 'server',
      dir,
      run: 'node server.js',
    })
    assert.equal(state.status, 'ready')
    assert.equal(state.host, '127.0.0.1')
  })

  await t.test('reports a crash with the stderr that caused it', async () => {
    const dir = await appDir('bad', { 'server.js': CRASHES })
    dirs.push(dir)
    const state = await supervisor.ensureStarted({
      id: 'broken',
      type: 'server',
      dir,
      run: 'node server.js',
    })
    assert.equal(state.status, 'crashed')
    assert.match(state.logs.join('\n'), /boom: could not find module/)
  })

  await t.test('starting an already-running app reuses it', async () => {
    const dir = await appDir('reuse', { 'server.js': HONOURS_PORT })
    dirs.push(dir)
    const app = { id: 'reuse', type: 'server', dir, run: 'node server.js' }
    const first = await supervisor.ensureStarted(app)
    const second = await supervisor.ensureStarted(app)
    assert.equal(first.port, second.port)
  })

  await t.test('stop takes an app back to stopped', async () => {
    const dir = await appDir('stopme', { 'server.js': HONOURS_PORT })
    dirs.push(dir)
    const app = { id: 'stopme', type: 'server', dir, run: 'node server.js' }
    await supervisor.ensureStarted(app)
    await supervisor.stop('stopme')
    assert.equal(supervisor.get('stopme').status, 'stopped')
  })

  await t.test('hands the configured key to an app that declared ai', async () => {
    const sup = createSupervisor({
      readyTimeoutMs: 15000,
      resolveApiKey: async () => 'sk-from-settings',
    })
    const dir = await appDir('ai', { 'server.js': ECHOES_KEY })
    dirs.push(dir)
    try {
      const state = await sup.ensureStarted({
        id: 'wants-ai',
        type: 'server',
        dir,
        run: 'node server.js',
        permissions: ['ai'],
      })
      assert.equal(await keySeenBy(state), 'sk-from-settings')
    } finally {
      await sup.stopAll()
    }
  })

  await t.test('an app that declared nothing never sees a key', async () => {
    // Even when the desktop itself inherited one from a terminal launch.
    process.env.ANTHROPIC_API_KEY = 'sk-leaked-from-shell'
    try {
      const sup = createSupervisor({
        readyTimeoutMs: 15000,
        resolveApiKey: async () => 'sk-from-settings',
      })
      const dir = await appDir('noai', { 'server.js': ECHOES_KEY })
      dirs.push(dir)
      try {
        const state = await sup.ensureStarted({
          id: 'no-ai',
          type: 'server',
          dir,
          run: 'node server.js',
        })
        assert.equal(await keySeenBy(state), 'ABSENT')
      } finally {
        await sup.stopAll()
      }
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  await t.test('emits state changes so the UI can follow along', async () => {
    const seen = []
    const sup = createSupervisor({
      readyTimeoutMs: 15000,
      onChange: (id, state) => seen.push([id, state.status]),
    })
    const dir = await appDir('watch', { 'server.js': HONOURS_PORT })
    dirs.push(dir)
    await sup.ensureStarted({ id: 'watch', type: 'server', dir, run: 'node server.js' })
    await sup.stopAll()
    const statuses = seen.filter(([id]) => id === 'watch').map(([, s]) => s)
    assert.ok(statuses.includes('starting'), `got ${statuses.join(',')}`)
    assert.ok(statuses.includes('ready'), `got ${statuses.join(',')}`)
  })
})
