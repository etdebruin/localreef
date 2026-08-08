/**
 * The gateway.
 *
 * One local HTTP server fronts every app. It routes on the Host header, serves
 * static apps straight off disk, and proxies server apps — including WebSocket
 * upgrades, which is the whole reason this is an HTTP server rather than a
 * custom protocol handler. Vite's HMR channel is a WebSocket, and Chromium
 * custom schemes cannot carry one.
 */

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

import { parseHostname } from '../core/routing.js'
import { safeResolve, contentType } from './paths.js'
import { parseCookies, authDecision, AUTH_COOKIE, AUTH_HEADER } from './auth.js'

const RESERVED_PREFIX = '/__desktop/'

// Per RFC 9110 these describe a single hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// Proxy with keep-alive off: lingering sockets otherwise keep server.close()
// hanging, which makes shutdown (and tests) unreliable.
const agent = new http.Agent({ keepAlive: false })

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

/**
 * Strip our own cookie before forwarding. It is HttpOnly so app JavaScript
 * cannot read it, but a spawned server app sees raw headers — no reason to
 * hand it the gateway token.
 */
function stripAuthCookie(cookieHeader) {
  if (!cookieHeader) return undefined
  const kept = String(cookieHeader)
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${AUTH_COOKIE}=`))
  return kept.length ? kept.join('; ') : undefined
}

function forwardableHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  delete out[AUTH_HEADER]
  const cookie = stripAuthCookie(headers.cookie)
  if (cookie) out.cookie = cookie
  else delete out.cookie
  return out
}

export function createGateway({ token, lookup }) {
  async function serveStatic(req, res, app, pathname) {
    let filePath = safeResolve(app.root, pathname)
    if (!filePath) return send(res, 404, 'Not found')

    try {
      let stat = await fsp.stat(filePath)

      // A directory requested without a trailing slash still means its index.
      if (stat.isDirectory()) {
        filePath = safeResolve(app.root, `${pathname}/`)
        if (!filePath) return send(res, 404, 'Not found')
        stat = await fsp.stat(filePath)
      }

      res.writeHead(200, {
        'content-type': contentType(filePath),
        'content-length': stat.size,
        // Apps change under the agent's hand; never let the browser hold a
        // stale copy between edits.
        'cache-control': 'no-store',
      })

      const stream = fs.createReadStream(filePath)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch {
      send(res, 404, 'Not found')
    }
  }

  function proxy(req, res, app) {
    const upstream = http.request(
      {
        // Whichever loopback family the app bound; see supervisor readiness.
        host: app.host ?? '127.0.0.1',
        port: app.port,
        path: req.url,
        method: req.method,
        headers: forwardableHeaders(req.headers),
        agent,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )

    upstream.on('error', () => {
      if (!res.headersSent) send(res, 502, 'App server unreachable')
      else res.destroy()
    })

    // If the client goes away mid-response, stop talking to the app server.
    res.on('close', () => upstream.destroy())

    req.pipe(upstream)
  }

  async function handle(req, res) {
    const appId = parseHostname(req.headers.host)
    if (!appId) return send(res, 404, 'Unknown app')

    const app = lookup(appId)
    if (!app) return send(res, 404, 'Unknown app')

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    const decision = authDecision({
      pathname: url.pathname,
      searchParams: url.searchParams,
      cookies: parseCookies(req.headers.cookie),
      headerToken: req.headers[AUTH_HEADER],
      token,
    })

    if (decision.action === 'deny') return send(res, 401, 'Unauthorized')

    if (decision.action === 'authorize') {
      return send(res, 302, '', {
        location: decision.redirectTo,
        'set-cookie': `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
      })
    }

    if (url.pathname.startsWith(RESERVED_PREFIX)) {
      if (url.pathname === '/__desktop/health') {
        return send(res, 200, 'ok', { 'content-type': 'application/json' })
      }
      return send(res, 404, 'Not found')
    }

    if (app.type === 'static') return serveStatic(req, res, app, url.pathname)

    if (app.status !== 'ready') {
      return send(res, 503, `${app.id} is still starting`, { 'retry-after': '1' })
    }

    return proxy(req, res, app)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Gateway error')
      else res.destroy()
    })
  })

  // Upgraded sockets are detached from the server's own connection tracking,
  // so closeAllConnections() cannot reach them — while getConnections() still
  // counts them, leaving server.close() waiting forever. Track them ourselves.
  const upgraded = new Set()

  // WebSocket / HMR. Header or cookie — and in practice it is always the
  // header, because an app frame is cross-site and never sends the cookie
  // back. Electron has to list ws:// and wss:// in its webRequest filter for
  // that header to arrive at all; see the note in src/main/index.js.
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))

    const appId = parseHostname(req.headers.host)
    const app = appId ? lookup(appId) : null

    if (!app || app.type === 'static' || app.status !== 'ready') return socket.destroy()
    const upgradeAuthed =
      req.headers[AUTH_HEADER] === token || parseCookies(req.headers.cookie)[AUTH_COOKIE] === token
    if (!upgradeAuthed) return socket.destroy()

    const upstream = http.request({
      host: app.host ?? '127.0.0.1',
      port: app.port,
      path: req.url,
      method: req.method,
      headers: forwardableHeaders({ ...req.headers, connection: 'Upgrade', upgrade: req.headers.upgrade }),
    })

    // Re-add the hop-by-hop headers the upgrade itself depends on.
    upstream.setHeader('connection', 'Upgrade')
    if (req.headers.upgrade) upstream.setHeader('upgrade', req.headers.upgrade)

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`
      const headerLines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`)
      socket.write(`${statusLine}\r\n${headerLines.join('\r\n')}\r\n\r\n`)

      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)

      // Tear down both halves together. Without the 'close' handlers a dropped
      // client leaves the upstream socket open, and every HMR reconnect strands
      // one against the dev server.
      const teardown = () => {
        socket.destroy()
        upSocket.destroy()
      }
      upSocket.on('error', teardown)
      upSocket.on('close', teardown)
      socket.on('error', teardown)
      socket.on('close', teardown)

      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })

    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  return {
    server,
    get port() {
      return server.address()?.port ?? null
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(this.port)))
    },
    close() {
      return new Promise((resolve) => {
        // Arm the close callback first, then drop live sockets: upgraded ones
        // by hand, the rest via the server's own bookkeeping.
        server.close(() => resolve())
        for (const socket of upgraded) socket.destroy()
        upgraded.clear()
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      })
    },
  }
}
