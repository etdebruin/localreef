/**
 * Screenshot the running desktop.
 *
 *   npm run shot                    # capture the default states
 *   npm run shot -- dock settings   # capture only these
 *
 * Why this exists: every UI change until now was verified through harnesses
 * and log inspection, because `screencapture` needs a macOS Screen Recording
 * grant that a headless agent shell does not have. That left "nobody has
 * looked at the desktop" as the top unverified claim in TODO.md, and it is how
 * a minimize button that visibly did nothing still passed its test.
 *
 * The OS permission is avoidable. Electron speaks the Chrome DevTools
 * Protocol, so the app can be told to photograph its own page — no capture of
 * the screen is involved, and nothing test-only has to be compiled into
 * src/main. This drives the real main process, real gateway, real apps.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const outDir = path.join(projectRoot, '.shots')

const PORT = 9333
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Named states worth looking at. Each `setup` runs in the page before capture,
 * so a screenshot can show a window open or a sheet raised rather than only
 * the idle desktop.
 */
const STATES = {
  dock: {
    description: 'Idle desktop — dock only',
    setup: null,
  },
  window: {
    description: 'An app window open',
    setup: `(async () => {
      document.querySelector('.dock-app')?.click()
      await new Promise((r) => setTimeout(r, 2500))
      return document.querySelectorAll('.window').length
    })()`,
  },
  minimized: {
    description: 'That window minimized back to the dock',
    setup: `(async () => {
      document.querySelector('.dock-app')?.click()
      await new Promise((r) => setTimeout(r, 2500))
      document.querySelector('.window .titlebar button.minimize')?.click()
      await new Promise((r) => setTimeout(r, 400))
      return document.querySelectorAll('.window[hidden]').length
    })()`,
  },
  linked: {
    description: 'A linked project (third dock app) running',
    setup: `(async () => {
      const apps = [...document.querySelectorAll('.dock-app')]
      apps[apps.length - 1]?.click()
      await new Promise((r) => setTimeout(r, 9000))
      return document.querySelectorAll('.window').length
    })()`,
  },
  'palette-nokey': {
    description: 'The ⌘K palette with no API key set yet',
    // Deliberately does NOT clear a saved key — a screenshot tool must not
    // mutate real settings. Run it with the env var unset instead:
    //   env -u ANTHROPIC_API_KEY npm run shot -- palette-nokey
    setup: `(async () => {
      document.getElementById('new-app')?.click()
      await new Promise((r) => setTimeout(r, 700))
      return document.getElementById('palette')?.hidden
    })()`,
  },
  'clock-edit': {
    description: 'The bundled clock running with its edit chat open',
    setup: `(async () => {
      const clock = [...document.querySelectorAll('.dock-app')].find((b) => b.title === 'Clock')
      clock?.click()
      await new Promise((r) => setTimeout(r, 4000))
      document.querySelector('.window .titlebar button.edit')?.click()
      await new Promise((r) => setTimeout(r, 600))
      return document.querySelectorAll('.window .chat').length
    })()`,
  },
  settings: {
    description: 'Settings sheet',
    setup: `(async () => {
      document.getElementById('open-settings')?.click()
      await new Promise((r) => setTimeout(r, 600))
      return document.getElementById('settings')?.hidden
    })()`,
  },
  palette: {
    description: '⌘K palette',
    setup: `(async () => {
      document.getElementById('new-app')?.click()
      await new Promise((r) => setTimeout(r, 400))
      return document.getElementById('palette')?.hidden
    })()`,
  },
}

/** Minimal CDP client. Node has a global WebSocket, so this needs no deps. */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.next = 1
    this.pending = new Map()

    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result)
    })
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.ws.close()
  }
}

/** The renderer is a file:// page; wait for it rather than assuming it is up. */
async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* devtools endpoint not listening yet */
    }
    await wait(300)
  }

  throw new Error('Timed out waiting for the renderer page to appear on the DevTools endpoint')
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const names = requested.length ? requested : Object.keys(STATES)

  for (const name of names) {
    if (!STATES[name]) {
      console.error(`Unknown state "${name}". Known: ${Object.keys(STATES).join(', ')}`)
      process.exit(1)
    }
  }

  await fs.mkdir(outDir, { recursive: true })

  // REEF_APP_BIN points this at a packaged build instead of the source tree,
  // which is the only way to verify the thing people actually launch: a GUI
  // launch inherits no shell PATH, so spawning a server app is a genuinely
  // different code path from `npm start`.
  const packaged = process.env.REEF_APP_BIN
  const electron = packaged
    ? spawn(packaged, [`--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(
        path.join(projectRoot, 'node_modules/.bin/electron'),
        ['.', `--remote-debugging-port=${PORT}`],
        { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      )

  const logs = []
  electron.stdout.on('data', (d) => logs.push(String(d)))
  electron.stderr.on('data', (d) => logs.push(String(d)))
  electron.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`electron exited early (${code}):\n${logs.join('')}`)
    }
  })

  let cdp
  try {
    const page = await findPage()
    cdp = new CDP(page.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // Apps have to finish being discovered before the dock has anything in it.
    await wait(1200)

    for (const name of names) {
      const state = STATES[name]

      if (state.setup) {
        // Fresh page per state: a click in one state would otherwise leak into
        // the next and the screenshots would stop being independent.
        await cdp.send('Page.reload')
        await wait(1600)
        const result = await cdp.send('Runtime.evaluate', {
          expression: state.setup,
          awaitPromise: true,
          returnByValue: true,
        })
        if (result.exceptionDetails) {
          console.error(`  setup for "${name}" threw: ${result.exceptionDetails.text}`)
        }
      }

      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(outDir, `${name}.png`)
      await fs.writeFile(file, Buffer.from(data, 'base64'))
      console.log(`  ${file}  — ${state.description}`)
    }
  } finally {
    cdp?.close()
    electron.kill('SIGTERM')
    await wait(400)
    electron.kill('SIGKILL')
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
