/**
 * A real shell in a window.
 *
 * The third sample: notes proves static serving, clock proves the WebSocket
 * relay carries server-to-client text frames, and this proves the relay is a
 * transparent pipe — interactive client-to-server input, binary output, and a
 * live pty behind it. It is also the one sample with dependencies (node-pty is
 * a native build), so it installs them itself on first launch: the server
 * binds immediately so the supervisor sees it ready, serves an "installing…"
 * page until `npm install` finishes, then the page reloads into the terminal.
 *
 * Protocol, one pty per socket:
 *   client → server   text frames   {t:'in', d:string} | {t:'size', c, r}
 *   server → client   binary frames raw pty output
 *                     text frames   {t:'exit', code} before close
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PORT = process.env.PORT || 0
const HOST = process.env.HOST || '127.0.0.1'

// ---------------------------------------------------------------------------
// Dependencies. Absent on a fresh checkout; installed once, in the background,
// while the page shows progress. Never crash the process over them — the
// supervisor would report the app dead when it is merely not ready yet.

let pty = null
let WebSocketServer = null
let installing = false
let installError = null

function depsReady() {
  if (pty && WebSocketServer) return true
  try {
    pty = require('node-pty')
    WebSocketServer = require('ws').WebSocketServer
    fixSpawnHelper()
    return true
  } catch {
    return false
  }
}

// npm strips the exec bit from prebuilt binaries, and macOS posix_spawnp
// refuses a non-executable helper — every pty.spawn dies with
// "posix_spawnp failed." until the bit is restored.
function fixSpawnHelper() {
  const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds')
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}

function ensureDeps() {
  if (depsReady() || installing || installError) return
  installing = true
  console.log('terminal: installing dependencies (first launch only)…')
  const npm = spawn('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  npm.on('error', (err) => {
    installing = false
    installError = `npm install failed to start: ${err.message}`
  })
  npm.on('exit', (code) => {
    installing = false
    if (code !== 0) installError = `npm install exited with code ${code}`
    else if (!depsReady()) installError = 'installed, but node-pty still failed to load'
  })
}

// ---------------------------------------------------------------------------
// Pages. The terminal page loads xterm.js from this server (mapped out of
// node_modules) so the app stays self-contained — no CDN, works offline.

const VENDOR = {
  '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
}

const TERMINAL_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Terminal</title>
    <link rel="stylesheet" href="/vendor/xterm.css" />
    <style>
      html, body { height: 100%; }
      body { margin: 0; background: #0f1218; }
      #term { position: absolute; inset: 8px 0 8px 8px; }
      #overlay {
        position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(15, 18, 24, 0.82); color: #939cb0;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }
      #overlay.shown { display: flex; }
    </style>
  </head>
  <body>
    <div id="term"></div>
    <div id="overlay">session ended — reload to start a new shell</div>
    <script src="/vendor/xterm.js"></script>
    <script src="/vendor/addon-fit.js"></script>
    <script>
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
        theme: { background: '#0f1218', foreground: '#e8ebf2', cursor: '#e8ebf2' },
      })
      const fit = new FitAddon.FitAddon()
      term.loadAddon(fit)
      term.open(document.getElementById('term'))
      fit.fit()
      term.focus()

      const ws = new WebSocket('ws://' + location.host + '/pty')
      ws.binaryType = 'arraybuffer'

      const sendSize = () => ws.send(JSON.stringify({ t: 'size', c: term.cols, r: term.rows }))
      ws.onopen = () => {
        sendSize()
        term.onData((d) => ws.send(JSON.stringify({ t: 'in', d })))
        term.onResize(sendSize)
      }
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') return // {t:'exit'} — the close handler covers it
        term.write(new Uint8Array(event.data))
      }
      ws.onclose = () => document.getElementById('overlay').classList.add('shown')
      window.addEventListener('resize', () => fit.fit())
    </script>
  </body>
</html>`

const INSTALLING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Terminal</title>
    <style>
      body {
        margin: 0; height: 100vh; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 10px;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        background: #0f1218; color: #e8ebf2;
      }
      #status { color: #939cb0; font-size: 13px; }
      #status.err { color: #ff7b72; }
    </style>
  </head>
  <body>
    <div>Setting up the terminal</div>
    <div id="status">installing node-pty — first launch only…</div>
    <script>
      const status = document.getElementById('status')
      const poll = setInterval(async () => {
        const health = await fetch('/healthz').then((r) => r.json()).catch(() => null)
        if (health?.pty) location.reload()
        if (health?.error) {
          clearInterval(poll)
          status.textContent = health.error
          status.className = 'err'
        }
      }, 1000)
    </script>
  </body>
</html>`

// ---------------------------------------------------------------------------

let sessions = 0
let wss = null

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, pid: process.pid, pty: depsReady(), sessions, error: installError }))
  }

  const vendor = VENDOR[req.url]
  if (vendor && depsReady()) {
    const [id, type] = vendor
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
    return res.end(fs.readFileSync(require.resolve(id)))
  }

  ensureDeps()
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(depsReady() ? TERMINAL_PAGE : INSTALLING_PAGE)
})

server.on('upgrade', (req, socket, head) => {
  if (!depsReady() || req.url !== '/pty') return socket.destroy()

  wss ??= new WebSocketServer({ noServer: true })
  wss.handleUpgrade(req, socket, head, (ws) => {
    // The shell must not inherit the port plumbing — a dev server started in
    // this terminal would read PORT and collide with the app's own.
    const env = { ...process.env, TERM: 'xterm-256color' }
    delete env.PORT
    delete env.HOST

    const shell = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env,
    })
    sessions++

    shell.onData((data) => ws.send(Buffer.from(data)))
    shell.onExit(({ exitCode }) => {
      sessions--
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit', code: exitCode }))
        ws.close()
      }
    })

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.t === 'in' && typeof msg.d === 'string') shell.write(msg.d)
      if (msg.t === 'size' && Number.isInteger(msg.c) && Number.isInteger(msg.r) && msg.c > 0 && msg.r > 0) {
        shell.resize(msg.c, msg.r)
      }
    })
    ws.on('close', () => shell.kill())
  })
})

server.listen(PORT, HOST, () => {
  ensureDeps()
  console.log(`Terminal listening on http://${HOST}:${server.address().port}`)
})
