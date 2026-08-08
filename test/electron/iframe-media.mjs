/**
 * Device access for a framed app.
 *
 *   npm run test:electron:media
 *
 * Permissions Policy defaults `microphone` to `self` — the parent's origin —
 * so an app on its own origin inside our iframe is denied the microphone
 * before any prompt exists. getUserMedia rejects with NotAllowedError and no
 * amount of clicking "allow" helps. The itppl studio's recorder hit exactly
 * this and reported "No microphone: Permission denied".
 *
 * Not part of `npm test`: Permissions Policy is browser behaviour, so the only
 * honest way to assert it is to frame a real page in a real Chromium and ask
 * the frame itself. Asserting the attribute we just set proves nothing —
 * `allow="microphone"` on a frame Chromium considers insecure is still denied.
 *
 * Run with DECLARE=0 to drop the manifest permission and watch the frame lose
 * the feature again — that is the "absent means denied" half of the contract.
 */
import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createGateway } from '../../src/gateway/index.js'
import { AUTH_HEADER, AUTH_PARAM } from '../../src/gateway/auth.js'
import { framePolicy } from '../../src/core/policy.js'

const TOKEN = 'harness-token'
const DECLARED = process.env.DECLARE === '0' ? [] : ['mic']

app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.reef.localhost 127.0.0.1')

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reef-media-'))

  // The app page reports what the browser will actually let it do. It does not
  // call getUserMedia: that needs a real input device and a macOS TCC grant,
  // neither of which says anything about the bug this guards.
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `<script>
       parent.postMessage({
         secure: window.isSecureContext,
         mic: document.featurePolicy.allowsFeature('microphone'),
         camera: document.featurePolicy.allowsFeature('camera'),
       }, '*')
     </script>`,
  )

  const gateway = createGateway({
    token: TOKEN,
    lookup: (id) => (id === 'probe' ? { id, type: 'static', root: dir } : null),
  })
  await gateway.listen(0)

  const appUrl = `http://probe.reef.localhost:${gateway.port}/?${AUTH_PARAM}=${TOKEN}`
  const allow = framePolicy(DECLARED)

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.reef.localhost/*'] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [AUTH_HEADER]: TOKEN } })
    },
  )

  // Same cross-site relationship as the desktop: a file:// parent framing an
  // app origin. That is what makes the policy default bite.
  const parent = path.join(dir, 'parent.html')
  await fs.writeFile(
    parent,
    `<iframe src="${appUrl}" allow="${allow}" style="width:600px;height:400px"></iframe>
     <script>
       window.addEventListener('message', (e) => {
         document.title = 'REPORT:' + JSON.stringify(e.data)
       })
     </script>`,
  )

  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  await win.loadFile(parent)
  await new Promise((r) => setTimeout(r, 2000))

  const title = win.webContents.getTitle()
  const report = title.startsWith('REPORT:') ? JSON.parse(title.slice(7)) : null

  console.log(`\nmanifest permissions: ${JSON.stringify(DECLARED)}`)
  console.log(`iframe allow="${allow}"`)
  console.log(`frame reports: ${JSON.stringify(report)}`)

  const wantMic = DECLARED.includes('mic')
  const ok =
    report?.secure === true && report?.mic === wantMic && report?.camera === false

  console.log(
    `\nRESULT: framed app ${report?.mic ? 'has' : 'does not have'} the microphone — ` +
      `${ok ? '✅ matches what it declared' : '❌ does not match what it declared'}`,
  )

  await gateway.close()
  await fs.rm(dir, { recursive: true, force: true })
  app.exit(ok ? 0 : 1)
})
