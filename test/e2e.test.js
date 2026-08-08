/**
 * The whole stack, minus Electron: scan the real apps/ folder, start what
 * needs starting, and reach both samples through the gateway exactly as the
 * renderer's iframes do.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanApps } from '../src/core/registry.js'
import { createSupervisor } from '../src/main/supervisor.js'
import { createGateway } from '../src/gateway/index.js'
import { AUTH_COOKIE } from '../src/gateway/auth.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'e2e-token'
const AUTHED = { cookie: `${AUTH_COOKIE}=${TOKEN}` }

function get(port, host, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, headers: { host, ...headers } },
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

test('end to end', async (t) => {
  const apps = new Map((await scanApps(path.join(projectRoot, 'apps'))).map((a) => [a.id, a]))
  const supervisor = createSupervisor({ readyTimeoutMs: 30000 })

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) => {
      const record = apps.get(id)
      if (!record || record.error) return null
      const state = supervisor.get(id)
      return {
        id,
        type: record.type,
        root: record.root,
        status: record.type === 'static' ? 'ready' : state.status,
        port: state.port,
        host: state.host,
      }
    },
  })

  await gateway.listen(0)
  const port = gateway.port
  const H = (id) => `${id}.reef.localhost:${port}`

  t.after(async () => {
    await supervisor.stopAll()
    await gateway.close()
  })

  await t.test('both sample apps are discovered and understood', () => {
    assert.equal(apps.get('notes')?.type, 'static')
    assert.equal(apps.get('clock')?.type, 'server')
    assert.equal(apps.get('clock')?.run, 'npm start')
    for (const app of apps.values()) {
      assert.equal(app.error, undefined, `${app.id}: ${app.error}`)
    }
  })

  await t.test('the static app serves instantly with no process', async () => {
    const state = await supervisor.ensureStarted(apps.get('notes'))
    assert.equal(state.status, 'ready')
    assert.equal(state.port, null)

    const res = await get(port, H('notes'), '/', AUTHED)
    assert.equal(res.status, 200)
    assert.match(res.body, /Write a note/)
  })

  await t.test('the server app starts and is proxied', async () => {
    const state = await supervisor.ensureStarted(apps.get('clock'))
    assert.equal(state.status, 'ready', state.error ?? '')
    assert.ok(state.port > 0)

    const res = await get(port, H('clock'), '/', AUTHED)
    assert.equal(res.status, 200)
    assert.match(res.body, /<title>Clock<\/title>/)
  })

  await t.test('the proxied app answers on its own routes too', async () => {
    const res = await get(port, H('clock'), '/healthz', AUTHED)
    assert.equal(res.status, 200)
    assert.match(res.body, /"ok":true/)
  })

  // The reason the gateway is an HTTP server rather than a custom protocol.
  await t.test('a websocket carries live frames through the gateway', async () => {
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []

    const frame = await new Promise((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `GET /ws HTTP/1.1\r\nHost: ${H('clock')}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
            `Cookie: ${AUTH_COOKIE}=${TOKEN}\r\n\r\n`,
        )
      })
      socket.on('data', (chunk) => {
        chunks.push(chunk)
        const joined = Buffer.concat(chunks)
        const headerEnd = joined.indexOf('\r\n\r\n')
        // Wait for the handshake plus at least one frame after it.
        if (headerEnd !== -1 && joined.length > headerEnd + 4) resolve(joined)
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('no websocket frame within 5s')), 5000).unref()
    })

    socket.destroy()

    const text = frame.toString('latin1')
    assert.match(text, /101 Switching Protocols/)
    assert.match(text, /Sec-WebSocket-Accept/i)

    const body = frame.subarray(frame.indexOf('\r\n\r\n') + 4)
    assert.equal(body[0], 0x81, 'expected a text frame')
    const payload = body.subarray(2, 2 + body[1]).toString('utf8')
    assert.match(payload, /"time":"\d{2}:\d{2}:\d{2}"/)
  })

  await t.test('stopping the app frees its process', async () => {
    await supervisor.stop('clock')
    assert.equal(supervisor.get('clock').status, 'stopped')

    const res = await get(port, H('clock'), '/', AUTHED)
    assert.equal(res.status, 503)
  })
})
