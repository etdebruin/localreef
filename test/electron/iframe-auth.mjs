/**
 * Reproduces the real framing situation: a file:// parent page embedding an
 * app origin in an iframe, which is exactly where SameSite=Lax cookies are
 * dropped. Observes the actual HTTP status rather than trying to read
 * cross-origin content.
 *
 *   npm run test:electron
 *
 * Not part of `npm test`: it needs a real Electron GUI. The plain suite sets
 * the Cookie header directly, which bypasses browser cookie policy entirely —
 * which is exactly why this bug shipped.
 */
import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER, AUTH_PARAM } from '../../src/gateway/auth.js'

const TOKEN = 'harness-token'
const INJECT_HEADER = process.env.INJECT_HEADER !== '0'

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

const statuses = []

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-harness-'))
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>APP CONTENT LOADED</h1>')

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) => (id === 'probe' ? { id, type: 'static', root: dir } : null),
  })
  await gateway.listen(0)

  const appUrl = `http://probe.reef.localhost:${gateway.port}/?${AUTH_PARAM}=${TOKEN}`
  const filter = { urls: ['*://*.reef.localhost/*'] }

  if (INJECT_HEADER) {
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    })
  }

  session.defaultSession.webRequest.onCompleted(filter, (details) => {
    statuses.push({ status: details.statusCode, url: details.url.replace(/\?.*/, '?…') })
  })

  // A file:// parent framing the app — same cross-site relationship as the
  // real desktop.
  const parent = path.join(dir, 'parent.html')
  await fs.writeFile(parent, `<iframe src="${appUrl}" style="width:600px;height:400px"></iframe>`)

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  await win.loadFile(parent)

  await new Promise((r) => setTimeout(r, 2500))

  console.log(`\nheader injection: ${INJECT_HEADER ? 'ON' : 'OFF'}`)
  for (const s of statuses) console.log(`  ${s.status}  ${s.url}`)

  const final = statuses.at(-1)?.status
  console.log(`\nRESULT: iframe final status ${final} — ${final === 200 ? '✅ app loads' : '❌ app blocked'}`)

  await gateway.close()
  await fs.rm(dir, { recursive: true, force: true })
  app.exit(final === 200 ? 0 : 1)
})
