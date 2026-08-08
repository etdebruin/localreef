/**
 * Does a *browser-initiated* WebSocket from an app iframe reach its server?
 *
 *   npm run test:electron:ws
 *
 * This is the WebSocket sibling of iframe-auth.mjs, and it exists for the same
 * reason that one does. `npm test` and `npm run test:vite` both drive the
 * gateway from Node, where the harness sets `x-reef-token` on the handshake
 * itself — so they prove the gateway *relays* an authorised upgrade, and prove
 * nothing at all about whether a real page's WebSocket ever carries that
 * credential.
 *
 * It does not, by default. Electron injects the header through a webRequest
 * filter, and Chrome match patterns treat a `*` scheme as http/https only, so
 * `*://*.reef.localhost/*` never matches `ws://…`. The upgrade arrives at
 * the gateway unauthenticated and is destroyed. The clock sample sat there
 * saying "disconnected — retrying", and Vite HMR would fail the same way.
 *
 * The app server records the upgrade itself, so the harness never has to read
 * anything cross-origin.
 */
import { app, BrowserWindow, session } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER, AUTH_PARAM } from '../../src/gateway/auth.js'

const TOKEN = 'harness-token'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// Set to 1 to watch the old filter fail.
const HTTP_ONLY_FILTER = process.env.HTTP_ONLY_FILTER === '1'

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

const PAGE = `<!doctype html>
<meta charset="utf-8">
<body>
<script>
  // Same origin as the page, so this rides the gateway's upgrade relay —
  // exactly what apps/clock does.
  const ws = new WebSocket('ws://' + location.host + '/ws')
  ws.onopen = () => { document.title = 'ws-open' }
  ws.onerror = () => { document.title = 'ws-error' }
  ws.onclose = () => { if (document.title !== 'ws-open') document.title = 'ws-closed' }
</script>
</body>`

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-ws-'))
  await fs.writeFile(path.join(dir, 'parent.html'), '')

  let upgradesSeen = 0
  const sockets = new Set()

  // A minimal stand-in for an app server that speaks WebSocket.
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })

  backend.on('upgrade', (req, socket) => {
    upgradesSeen += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))

    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })

  await new Promise((r) => backend.listen(0, '127.0.0.1', r))
  const backendPort = backend.address().port

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) =>
      id === 'probe'
        ? { id, type: 'server', status: 'ready', port: backendPort, host: '127.0.0.1' }
        : null,
  })
  await gateway.listen(0)

  // The filter under test. The http-only form is what shipped.
  const urls = HTTP_ONLY_FILTER
    ? ['*://*.reef.localhost/*']
    : ['*://*.reef.localhost/*', 'ws://*.reef.localhost/*', 'wss://*.reef.localhost/*']

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
  })

  const appUrl = `http://probe.reef.localhost:${gateway.port}/?${AUTH_PARAM}=${TOKEN}`
  const parent = path.join(dir, 'parent.html')
  await fs.writeFile(parent, `<iframe src="${appUrl}" style="width:400px;height:300px"></iframe>`)

  const win = new BrowserWindow({ show: false, width: 700, height: 500 })
  await win.loadFile(parent)
  await new Promise((r) => setTimeout(r, 2500))

  const frame = win.webContents.mainFrame.frames[0]
  const title = frame ? await frame.executeJavaScript('document.title') : '(no frame)'

  console.log(`\n  filter: ${urls.join('  ')}`)
  console.log(`  app-server upgrades seen: ${upgradesSeen}`)
  console.log(`  page reports: ${title || '(none)'}`)

  const passed = upgradesSeen > 0 && title === 'ws-open'
  console.log(
    `\nRESULT: ${passed ? '✅ the iframe websocket connected' : '❌ the iframe websocket never connected'}`,
  )

  for (const socket of sockets) socket.destroy()
  backend.close()
  await gateway.close()
  await fs.rm(dir, { recursive: true, force: true })
  app.exit(passed ? 0 : 1)
})

process.on('unhandledRejection', (err) => {
  console.error(`harness crashed: ${err?.stack ?? err}`)
  app.exit(1)
})
