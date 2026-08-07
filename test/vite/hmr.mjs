/**
 * Does a real Vite dev server work through the gateway?
 *
 *   npm run test:vite
 *
 * Separate from `npm test` because it installs Vite on first run. It exists
 * because the entire reason the gateway is an HTTP server rather than an
 * `app://` protocol is that Vite's HMR needs a WebSocket — and that claim went
 * unverified for a long time while a hand-rolled sample stood in for it. When
 * it was finally run, two real bugs fell out: Vite binds IPv6 loopback only,
 * and the proxy host was not being threaded through.
 *
 * Checks the three things the design depends on:
 *   1. the supervisor adopts the port Vite announces (it ignores PORT)
 *   2. Vite serves through the proxy without rejecting the forwarded Host
 *   3. the HMR WebSocket connects AND carries an update after a file edit
 */
import fs from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readApp } from '../../src/core/registry.js'
import { createSupervisor } from '../../src/main/supervisor.js'
import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER } from '../../src/gateway/auth.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(here, 'fixture')

// Build the fixture on first run; reuse node_modules afterwards.
await fs.mkdir(path.join(DIR, 'src'), { recursive: true })
await fs.writeFile(path.join(DIR, 'package.json'), JSON.stringify({
  name: 'vitesample', private: true, type: 'module',
  scripts: { dev: 'vite' }, devDependencies: { vite: '^7.0.0' },
}, null, 2))
await fs.writeFile(path.join(DIR, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Vite Sample</title></head>' +
  '<body><div id="app">loading</div><script type="module" src="/src/main.js"></script></body></html>')
await fs.writeFile(path.join(DIR, 'src/main.js'),
  "document.getElementById('app').textContent = 'MARKER_V1'\n")

try {
  await fs.stat(path.join(DIR, 'node_modules/vite'))
} catch {
  console.log('installing vite (first run only)…')
  await new Promise((resolve, reject) =>
    execFile('npm', ['install', '--silent'], { cwd: DIR }, (err) => (err ? reject(err) : resolve())))
}
const TOKEN = 'vite-test'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/** Minimal server->client frame reader; server frames are never masked. */
function decodeFrames(buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f
    let len = buf[i + 1] & 0x7f
    let offset = i + 2
    if (len === 126) {
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    if (offset + len > buf.length) break
    if (opcode === 0x1) out.push(buf.subarray(offset, offset + len).toString('utf8'))
    i = offset + len
  }
  return out
}

const record = await readApp(DIR)
console.log(`registry: type=${record.type}  run="${record.run}"\n`)

const supervisor = createSupervisor({ readyTimeoutMs: 60000 })
const gateway = createGateway({
  token: TOKEN,
  lookup: (id) => {
    if (id !== record.id) return null
    const s = supervisor.get(id)
    return { id, type: record.type, root: record.root, status: s.status, port: s.port, host: s.host }
  },
})
await gateway.listen(0)
const host = `${record.id}.desktop.localhost:${gateway.port}`

console.log('1. start Vite under the supervisor')
const state = await supervisor.ensureStarted(record)
check('vite reaches ready', state.status === 'ready', `${state.status} port=${state.port} ${state.error ?? ''}`)
// Vite ignores PORT and picks 5173 (or next free), so a matching port would
// mean the stdout-sniffing path never ran.
check('port was adopted from stdout, not the injected PORT', state.port === 5173 || state.port > 1024,
  `adopted ${state.port}`)

console.log('\n2. fetch the page through the gateway')
const page = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port: gateway.port, path: '/', headers: { host, [AUTH_HEADER]: TOKEN } },
    (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    },
  )
  req.on('error', reject)
  req.end()
})
check('vite serves 200 through the proxy', page.status === 200, `status ${page.status}`)
check('no host-check rejection', !/host|blocked|not allowed/i.test(page.body.slice(0, 400)))
check('vite injected its HMR client', page.body.includes('/@vite/client'))

console.log('\n3. HMR websocket through the gateway')
const key = crypto.randomBytes(16).toString('base64')
const socket = net.connect(gateway.port, '127.0.0.1')
let buffer = Buffer.alloc(0)
const messages = []

const handshake = await new Promise((resolve, reject) => {
  socket.on('connect', () => {
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: vite-hmr\r\n${AUTH_HEADER}: ${TOKEN}\r\n\r\n`,
    )
  })
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const end = buffer.indexOf('\r\n\r\n')
    if (end !== -1) {
      const head = buffer.subarray(0, end).toString()
      const rest = buffer.subarray(end + 4)
      buffer = Buffer.alloc(0)
      messages.push(...decodeFrames(rest))
      socket.removeAllListeners('data')
      socket.on('data', (c) => {
        buffer = Buffer.concat([buffer, c])
        messages.push(...decodeFrames(buffer))
        buffer = Buffer.alloc(0)
      })
      resolve(head)
    }
  })
  socket.on('error', reject)
  setTimeout(() => reject(new Error('handshake timeout')), 10000).unref()
})

check('HMR upgrade returns 101', /101 Switching Protocols/.test(handshake))
check('vite accepted the vite-hmr subprotocol', /vite-hmr/i.test(handshake), handshake.split('\r\n')[0])

await new Promise((r) => setTimeout(r, 1200))
check('vite sent a connected message', messages.some((m) => m.includes('"connected"')),
  messages[0]?.slice(0, 60) ?? 'nothing received')

console.log('\n4. edit a file and wait for an HMR message')
const before = messages.length
await fs.writeFile(path.join(DIR, 'src/main.js'),
  "document.getElementById('app').textContent = 'MARKER_V2'\n")

const deadline = Date.now() + 12000
while (Date.now() < deadline && messages.length === before) {
  await new Promise((r) => setTimeout(r, 200))
}
const fresh = messages.slice(before)
check('an HMR message arrived after the edit', fresh.length > 0,
  fresh.map((m) => m.slice(0, 90)).join(' | ') || 'none within 12s')

socket.destroy()
await supervisor.stopAll()
await gateway.close()

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
