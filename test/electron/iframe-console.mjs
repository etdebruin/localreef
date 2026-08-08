/**
 * An app frame's errors reach main, attributable to the app.
 *
 *   npm run test:electron:console
 *
 * The console-error capture rests on one browser behaviour nothing in Node can
 * prove: that an uncaught exception inside a cross-origin app iframe surfaces
 * on the *parent* webContents' console-message event, carrying a frame URL the
 * shell can attribute with parseHostname. If Chromium ever stops forwarding
 * frame console output, or the event loses its frame, the capture silently
 * records nothing and every fix prompt quietly gets worse — this is the test
 * that turns that into a red run.
 *
 * Two error shapes matter, because they arrive differently: an uncaught
 * exception (what a dead button usually is) and an explicit console.error.
 */
import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER, AUTH_PARAM } from '../../src/gateway/auth.js'
import { createConsoleCapture } from '../../src/core/console.js'

const TOKEN = 'harness-token'

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reef-console-'))

  // The app: a button wired to a handler that throws — the First Chair bug —
  // plus one deliberate console.error at load.
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `<button id="log">Log first weigh-in</button>
     <script>
       console.error('load-time complaint')
       document.getElementById('log').addEventListener('click', () => {
         null.weight = 200 // TypeError, uncaught
       })
       document.getElementById('log').click()
     </script>`,
  )

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) => (id === 'first-chair' ? { id, type: 'static', root: dir } : null),
  })
  await gateway.listen(0)

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.reef.localhost/*'] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    },
  )

  // Same cross-site shape as the desktop: file:// parent, app origin framed.
  const appUrl = `http://first-chair.reef.localhost:${gateway.port}/?${AUTH_PARAM}=${TOKEN}`
  const parent = path.join(dir, 'parent.html')
  await fs.writeFile(
    parent,
    `<script>console.error('the shell itself grumbling')</script>
     <iframe src="${appUrl}" style="width:600px;height:400px"></iframe>`,
  )

  // Exactly the wiring in src/main/index.js: one listener, both signatures,
  // records into the capture.
  const capture = createConsoleCapture()
  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  win.webContents.on('console-message', (...args) => {
    const details = typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    capture.record({
      level: details ? details.level : args[1],
      message: details ? details.message : args[2],
      line: details ? details.lineNumber : args[3],
      sourceUrl: details ? details.sourceId : args[4],
      frameUrl: details?.frame?.url,
    })
  })

  await win.loadFile(parent)
  await new Promise((r) => setTimeout(r, 2000))

  const captured = capture.recent('first-chair')
  console.log(`\ncaptured for first-chair:\n  ${captured.join('\n  ') || '(nothing)'}`)

  const checks = [
    ['the uncaught click-handler exception is captured', captured.some((e) => /TypeError/.test(e))],
    ['an explicit console.error is captured', captured.some((e) => /load-time complaint/.test(e))],
    ['entries say where the error was thrown', captured.some((e) => /index\.html:\d+/.test(e))],
    ["the shell's own errors do not pollute the app", !captured.some((e) => /grumbling/.test(e))],
  ]

  let ok = true
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? '✅' : '❌'} ${name}`)
    if (!passed) ok = false
  }

  await gateway.close()
  await fs.rm(dir, { recursive: true, force: true })
  app.exit(ok ? 0 : 1)
})
