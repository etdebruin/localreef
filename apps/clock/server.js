/**
 * A zero-dependency server app.
 *
 * Exists to prove the two things a static app cannot: that Local Reef
 * spawns and proxies a real server, and that WebSocket upgrades survive the
 * gateway. The WebSocket is hand-rolled so this app needs no npm install —
 * server-to-client text frames only, which is all a ticking clock needs.
 */

const http = require('http')
const crypto = require('crypto')

const PORT = process.env.PORT || 0
const HOST = process.env.HOST || '127.0.0.1'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Clock</title>
    <style>
      body {
        margin: 0; height: 100vh; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px;
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        background: #0f1218; color: #e8ebf2;
      }
      #time { font-size: 58px; font-weight: 200; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
      #status { color: #939cb0; font-size: 13px; }
      #status.live::before { content: '●'; color: #4ade80; margin-right: 6px; }
      #status.down::before { content: '●'; color: #ff7b72; margin-right: 6px; }
      code { background: #1b1f2a; padding: 2px 7px; border-radius: 5px; font-size: 12px; color: #b8c1d4; }
    </style>
  </head>
  <body>
    <div id="time">--:--:--</div>
    <div id="status">connecting…</div>
    <code id="origin"></code>
    <script>
      const timeEl = document.getElementById('time')
      const statusEl = document.getElementById('status')
      document.getElementById('origin').textContent = location.origin

      function connect() {
        // Same origin as the page, so this rides the gateway's upgrade relay.
        const ws = new WebSocket(\`ws://\${location.host}/ws\`)

        ws.onopen = () => {
          statusEl.textContent = 'live over websocket, through the gateway'
          statusEl.className = 'live'
        }
        ws.onmessage = (event) => {
          timeEl.textContent = JSON.parse(event.data).time
        }
        ws.onclose = () => {
          statusEl.textContent = 'disconnected — retrying'
          statusEl.className = 'down'
          setTimeout(connect, 1000)
        }
        ws.onerror = () => ws.close()
      }

      connect()
    </script>
  </body>
</html>`

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, pid: process.pid }))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})

/** Text frame, server to client. Payloads here are far below the 126-byte mark. */
function encodeFrame(text) {
  const payload = Buffer.from(text)
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  }
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  const tick = setInterval(() => {
    const time = new Date().toLocaleTimeString('en-GB')
    socket.write(encodeFrame(JSON.stringify({ time })))
  }, 1000)

  const stop = () => {
    clearInterval(tick)
    socket.destroy()
  }
  socket.on('close', stop)
  socket.on('error', stop)
})

server.listen(PORT, HOST, () => {
  console.log(`Clock listening on http://${HOST}:${server.address().port}`)
})
