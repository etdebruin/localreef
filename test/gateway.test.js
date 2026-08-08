import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../src/gateway/index.js'
import { AUTH_COOKIE, AUTH_PARAM } from '../src/gateway/auth.js'

const TOKEN = 'tok_test'
const AUTHED = { cookie: `${AUTH_COOKIE}=${TOKEN}` }

/** Raw http.request so we can forge the Host header, which fetch will not allow. */
function request(port, host, reqPath, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: { host, ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

let dir, gateway, backend, backendPort

test('gateway', async (t) => {
  // A static app on disk.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-gw-'))
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>notes</h1>')
  await fs.mkdir(path.join(dir, 'sub'))
  await fs.writeFile(path.join(dir, 'sub', 'app.js'), 'export const x = 1')
  await fs.writeFile(path.join(path.dirname(dir), 'ld-outside-secret'), 'SECRET')

  // A backend standing in for a spawned dev server, speaking HTTP and upgrades.
  backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`backend saw ${req.method} ${req.url}`)
  })
  // Upgraded sockets escape closeAllConnections() (Node detaches them from the
  // server's tracking), so hold them to tear down explicitly.
  const backendSockets = new Set()
  backend.on('upgrade', (req, socket) => {
    backendSockets.add(socket)
    socket.on('close', () => backendSockets.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write('hmr-hello')
  })
  await new Promise((r) => backend.listen(0, '127.0.0.1', r))
  backendPort = backend.address().port

  // A backend on IPv6 loopback, as Vite binds.
  const backend6 = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ipv6 backend saw ' + req.url)
  })
  await new Promise((r) => backend6.listen(0, '::1', r))
  const backend6Port = backend6.address().port

  const apps = {
    notes: { id: 'notes', type: 'static', root: dir },
    six: { id: 'six', type: 'server', status: 'ready', port: backend6Port, host: '::1' },
    chart: { id: 'chart', type: 'server', status: 'ready', port: backendPort },
    slow: { id: 'slow', type: 'server', status: 'starting' },
  }

  gateway = createGateway({ token: TOKEN, lookup: (id) => apps[id] ?? null })
  await gateway.listen(0)
  const port = gateway.port
  const H = (id) => `${id}.colony.localhost:${port}`

  t.after(async () => {
    await gateway.close()
    for (const socket of backendSockets) socket.destroy()
    backend.closeAllConnections?.()
    await new Promise((r) => backend.close(r))
    backend6.closeAllConnections?.()
    await new Promise((r) => backend6.close(r))
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(path.join(path.dirname(dir), 'ld-outside-secret'), { force: true })
  })

  await t.test('rejects an unknown host', async () => {
    const res = await request(port, `ghost.colony.localhost:${port}`, '/', { headers: AUTHED })
    assert.equal(res.status, 404)
  })

  await t.test('rejects a foreign Host header', async () => {
    const res = await request(port, 'evil.com', '/', { headers: AUTHED })
    assert.equal(res.status, 404)
  })

  await t.test('health probe needs no auth', async () => {
    const res = await request(port, H('notes'), '/__colony/health')
    assert.equal(res.status, 200)
  })

  await t.test('denies an unauthenticated request', async () => {
    const res = await request(port, H('notes'), '/')
    assert.equal(res.status, 401)
  })

  await t.test('authorizes via the token param and sets a cookie', async () => {
    const res = await request(port, H('notes'), `/?${AUTH_PARAM}=${TOKEN}`)
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, '/')
    const setCookie = String(res.headers['set-cookie'])
    assert.match(setCookie, new RegExp(`${AUTH_COOKIE}=${TOKEN}`))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite/i)
  })

  // A framed app authenticates by header, not cookie — see auth.js.
  await t.test('accepts the token as a request header', async () => {
    const res = await request(port, H('notes'), '/', {
      headers: { 'x-colony-token': TOKEN },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body, '<h1>notes</h1>')
  })

  await t.test('rejects a wrong token header', async () => {
    const res = await request(port, H('notes'), '/', {
      headers: { 'x-colony-token': 'wrong' },
    })
    assert.equal(res.status, 401)
  })

  await t.test('relays a websocket upgrade authenticated by header', async () => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    await new Promise((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: ${H('chart')}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nX-Colony-Token: ${TOKEN}\r\n\r\n`,
        )
      })
      socket.on('data', (c) => {
        chunks.push(c)
        if (chunks.join('').includes('hmr-hello')) resolve()
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('upgrade timed out')), 3000).unref?.()
    })
    socket.destroy()
    assert.match(chunks.join(''), /101 Switching Protocols/)
  })

  await t.test('serves index.html for the root', async () => {
    const res = await request(port, H('notes'), '/', { headers: AUTHED })
    assert.equal(res.status, 200)
    assert.equal(res.body, '<h1>notes</h1>')
    assert.match(res.headers['content-type'], /text\/html/)
  })

  await t.test('serves a nested file with the right type', async () => {
    const res = await request(port, H('notes'), '/sub/app.js', { headers: AUTHED })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/javascript/)
  })

  await t.test('404s a missing file', async () => {
    const res = await request(port, H('notes'), '/nope.txt', { headers: AUTHED })
    assert.equal(res.status, 404)
  })

  await t.test('refuses to serve outside the app root', async () => {
    const res = await request(port, H('notes'), '/../ld-outside-secret', { headers: AUTHED })
    assert.notEqual(res.status, 200)
    assert.doesNotMatch(res.body, /SECRET/)
  })

  await t.test('proxies a ready node app', async () => {
    const res = await request(port, H('chart'), '/api/data?q=1', { headers: AUTHED })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'backend saw GET /api/data?q=1')
  })

  await t.test('proxies an app bound to IPv6 loopback', async () => {
    const res = await request(port, H('six'), '/hello', { headers: AUTHED })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'ipv6 backend saw /hello')
  })

  await t.test('reports 503 while a node app is still starting', async () => {
    const res = await request(port, H('slow'), '/', { headers: AUTHED })
    assert.equal(res.status, 503)
  })

  // The whole reason we run a gateway instead of a custom protocol.
  await t.test('relays a websocket upgrade to the backend', async () => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    await new Promise((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: ${H('chart')}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nCookie: ${AUTH_COOKIE}=${TOKEN}\r\n\r\n`,
        )
      })
      socket.on('data', (c) => {
        chunks.push(c)
        if (chunks.join('').includes('hmr-hello')) resolve()
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('upgrade timed out')), 3000).unref?.()
    })
    socket.destroy()
    const got = chunks.join('')
    assert.match(got, /101 Switching Protocols/)
    assert.match(got, /hmr-hello/)
  })
})
