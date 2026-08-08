/**
 * An app's localStorage survives a real relaunch — because the port held.
 *
 *   npm run test:electron:storage
 *
 * Two separate Electron processes share one userData dir: the first launch
 * frames an app on a fixed port and writes localStorage; the second launch
 * frames the same app on the same port and must read the value back. Nothing
 * single-process can prove this — storage lives in the profile on disk, and
 * only a genuine process boundary shows whether it was flushed and re-keyed.
 *
 * This guards the First Chair data loss: the gateway listened on port 0, so
 * every launch minted a new origin (origin = scheme+host+PORT) and stranded
 * every app's data under the previous one. Run the read phase with
 * REEF_STORAGE_DRIFT=1 to relive it — same app, different port, data gone.
 */
import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER, AUTH_PARAM } from '../../src/gateway/auth.js'

const TOKEN = 'harness-token'
const PHASE = process.env.REEF_STORAGE_PHASE ?? 'write'
const PORT = 7444
const DRIFT = process.env.REEF_STORAGE_DRIFT === '1'

// Both phases must resolve to the same profile, or there is nothing to prove.
const userData = path.join(os.tmpdir(), 'reef-storage-harness')
app.setPath('userData', userData)
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

app.whenReady().then(async () => {
  if (PHASE === 'write') {
    // A fresh profile: this run must be the one that writes.
    await fs.rm(userData, { recursive: true, force: true })
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reef-storage-app-'))
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `<script>
       const had = localStorage.getItem('storage-proof')
       localStorage.setItem('storage-proof', 'weigh-in-230')
       parent.postMessage({ had }, '*')
     </script>`,
  )

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) => (id === 'first-chair' ? { id, type: 'static', root: dir } : null),
  })
  await gateway.listen(DRIFT ? PORT + 1 : PORT)

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.reef.localhost/*'] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    },
  )

  const appUrl = `http://first-chair.reef.localhost:${gateway.port}/?${AUTH_PARAM}=${TOKEN}`
  const parent = path.join(dir, 'parent.html')
  await fs.writeFile(
    parent,
    `<iframe src="${appUrl}" style="width:600px;height:400px"></iframe>
     <script>
       window.addEventListener('message', (e) => {
         document.title = 'REPORT:' + JSON.stringify(e.data)
       })
     </script>`,
  )

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  await win.loadFile(parent)
  await new Promise((r) => setTimeout(r, 1500))

  const title = win.webContents.getTitle()
  const report = title.startsWith('REPORT:') ? JSON.parse(title.slice(7)) : null

  // Ask the profile to hit disk before this process dies — the next launch
  // reads what was flushed, exactly like a user quitting the shell.
  win.webContents.session.flushStorageData()
  await new Promise((r) => setTimeout(r, 400))

  console.log(`\nphase=${PHASE} port=${gateway.port} frame had: ${JSON.stringify(report?.had)}`)

  let ok
  if (PHASE === 'write') {
    ok = report !== null && report.had === null
    console.log(ok ? '  ✅ fresh profile wrote its value' : '  ❌ expected a fresh profile')
  } else if (DRIFT) {
    ok = report !== null && report.had === null
    console.log(
      ok
        ? '  ✅ drifted port = new origin = data stranded (the bug, demonstrated)'
        : '  ❌ data followed across ports?! origins are broken',
    )
  } else {
    ok = report?.had === 'weigh-in-230'
    console.log(
      ok
        ? '  ✅ the value survived a real relaunch on the pinned port'
        : '  ❌ storage did not survive the relaunch',
    )
  }

  await gateway.close()
  await fs.rm(dir, { recursive: true, force: true })
  app.exit(ok ? 0 : 1)
})
