/**
 * Does a real shell work through the gateway?
 *
 *   npm run test:terminal
 *
 * Separate from `npm test` because it installs node-pty (a native build) on
 * first run. The terminal sample is the only bundled app with dependencies,
 * and the only one whose WebSocket traffic is interactive and binary — the
 * clock proves the relay carries server-to-client text frames, this proves
 * client-to-server input, binary output, and a live pty behind it all.
 *
 * Checks the four things a terminal actually depends on:
 *   1. the page serves through the proxy with the terminal mount
 *   2. a command typed over the websocket comes back with its output — a
 *      real pty echoing, not a pipe
 *   3. resize is honoured: after {t:'size'}, tput reports the new width
 *   4. closing the socket reaps the shell — /healthz sessions drops to 0
 */
import http from 'node:http'
import path from 'node:path'

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { readApp } from '../../src/core/registry.js'
import { createSupervisor } from '../../src/main/supervisor.js'
import { createGateway } from '../../src/gateway/index.js'
import { AUTH_COOKIE } from '../../src/gateway/auth.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(here, '../../apps/terminal')
const TOKEN = 'terminal-test'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

function get(port, host, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, headers: { host, cookie: `${AUTH_COOKIE}=${TOKEN}` } },
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The app installs its own dependencies on first launch, but the test installs
// them up front so a network hiccup fails here, loudly, not mid-assertion.
const requireApp = createRequire(path.join(DIR, 'server.js'))
try {
  requireApp.resolve('node-pty')
  requireApp.resolve('ws')
} catch {
  console.log('installing terminal dependencies (first run only)…')
  await new Promise((resolve, reject) =>
    execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: DIR }, (err) => (err ? reject(err) : resolve())))
}
const WebSocket = requireApp('ws')

const app = await readApp(DIR)
if (app.error) {
  console.log(`  ❌ readApp: ${app.error}`)
  process.exit(1)
}

const supervisor = createSupervisor({ readyTimeoutMs: 30000 })
const gateway = createGateway({
  token: TOKEN,
  lookup: (id) => {
    if (id !== app.id) return null
    const state = supervisor.get(id)
    return { id, type: app.type, root: app.root, status: state.status, port: state.port, host: state.host }
  },
})

await gateway.listen(0)
const H = `terminal.reef.localhost:${gateway.port}`

try {
  const state = await supervisor.ensureStarted(app)
  check('supervisor reaches ready', state.status === 'ready', state.error ?? '')

  // Deps are preinstalled above, so the pty must be live once the server is up.
  let health = null
  for (let i = 0; i < 50 && !health?.pty; i++) {
    const res = await get(gateway.port, H, '/healthz')
    health = res.status === 200 ? JSON.parse(res.body) : null
    if (!health?.pty) await sleep(200)
  }
  check('healthz reports the pty live', health?.pty === true, JSON.stringify(health))

  const page = await get(gateway.port, H, '/')
  check('page serves the terminal mount', page.status === 200 && /xterm/.test(page.body), `status ${page.status}`)

  // Drive a session the way the page does: JSON text frames in, binary out.
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/pty`, {
    headers: { host: H, cookie: `${AUTH_COOKIE}=${TOKEN}` },
  })
  let output = ''
  ws.on('message', (data, isBinary) => {
    if (isBinary) output += data.toString('utf8')
  })
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true))
    ws.on('error', () => resolve(false))
    setTimeout(() => resolve(false), 5000).unref()
  })
  check('websocket session opens through the gateway', opened)

  const outputHas = async (re, ms = 15000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (re.test(output)) return true
      await sleep(100)
    }
    return false
  }

  // %s keeps the marker out of the echoed command line, so a match proves the
  // shell ran it — not that the pty echoed our keystrokes back.
  ws.send(JSON.stringify({ t: 'in', d: "printf 'REEF_%s\\n' OK\r" }))
  check('a typed command runs and its output comes back', await outputHas(/REEF_OK/))

  ws.send(JSON.stringify({ t: 'size', c: 123, r: 30 }))
  await sleep(200)
  ws.send(JSON.stringify({ t: 'in', d: 'printf "COLS_%s\\n" "$(tput cols)"\r' }))
  check('resize reaches the pty', await outputHas(/COLS_123/))

  ws.close()
  let sessions = -1
  for (let i = 0; i < 50; i++) {
    const res = await get(gateway.port, H, '/healthz')
    sessions = JSON.parse(res.body).sessions
    if (sessions === 0) break
    await sleep(200)
  }
  check('closing the socket reaps the shell', sessions === 0, `sessions=${sessions}`)
} finally {
  await supervisor.stopAll()
  await gateway.close()
}

process.exit(results.every(Boolean) ? 0 : 1)
