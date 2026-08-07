/**
 * Process supervision.
 *
 * Owns the lifecycle of every spawned app: start on demand, detect readiness,
 * capture output, report crashes with the stderr that caused them.
 *
 * Readiness runs two strategies at once because neither is sufficient alone.
 * We inject PORT, but Vite ignores it and picks its own; Next.js honours it.
 * So we poll the port we assigned *and* watch stdout for a port the server
 * announces, and take whichever answers first.
 */

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'

import { sniffPort } from '../core/probe.js'

const MAX_LOG_LINES = 200
const POLL_INTERVAL_MS = 150
const STOP_GRACE_MS = 2000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A GUI-launched Electron app does not inherit the shell's PATH, so `node` and
 * `npm` are simply missing. Ask a login shell once and cache the answer.
 */
let cachedPath
async function userPath() {
  if (cachedPath !== undefined) return cachedPath

  cachedPath = await new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const child = execFile(shell, ['-ilc', 'echo -n "$PATH"'], { timeout: 3000 }, (err, stdout) => {
      resolve(err || !stdout?.trim() ? process.env.PATH : stdout.trim())
    })
    child.on('error', () => resolve(process.env.PATH))
  })

  return cachedPath
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export function createSupervisor({ onChange = () => {}, readyTimeoutMs = 30000 } = {}) {
  /** id -> { status, port, logs, proc, pending } */
  const states = new Map()

  const publicState = (s) => ({
    status: s.status,
    port: s.port ?? null,
    logs: s.logs ?? [],
    error: s.error,
  })

  function setState(id, patch) {
    const current = states.get(id) ?? { status: 'stopped', port: null, logs: [] }
    const next = { ...current, ...patch }
    states.set(id, next)
    onChange(id, publicState(next))
    return next
  }

  function get(id) {
    const s = states.get(id)
    return s ? publicState(s) : { status: 'stopped', port: null, logs: [] }
  }

  async function start(app) {
    // A declared port wins: some servers hardcode theirs and ignore PORT
    // entirely, so there is nothing to assign — we just have to know where
    // to look for them.
    const assignedPort = app.port ?? (await freePort())
    const logs = []
    let announcedPort = null

    setState(app.id, { status: 'starting', port: null, logs, error: undefined })

    const proc = spawn(app.run, {
      cwd: app.dir,
      shell: true,
      // Own process group. `npm start` is really sh -> npm -> node, and
      // signalling only the shell orphans the server that actually holds the
      // port — so every relaunch would leak a listener.
      detached: true,
      env: {
        ...process.env,
        PATH: await userPath(),
        PORT: String(assignedPort),
        HOST: '127.0.0.1',
        DESKTOP: '1',
        DESKTOP_APP_ID: app.id,
        ...(app.dataDir ? { DESKTOP_DATA_DIR: app.dataDir } : {}),
        ...(app.env ?? {}),
      },
    })

    setState(app.id, { proc })

    let exited = false
    let exitInfo = null

    const record = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        logs.push(line)
        if (logs.length > MAX_LOG_LINES) logs.shift()
        announcedPort ??= sniffPort(line)
      }
    }

    proc.stdout?.on('data', record)
    proc.stderr?.on('data', record)
    proc.on('error', (err) => {
      exited = true
      exitInfo = `Failed to start: ${err.message}`
    })
    proc.on('exit', (code, signal) => {
      exited = true
      exitInfo ??= `Exited with ${signal ? `signal ${signal}` : `code ${code}`}`
    })

    const deadline = Date.now() + readyTimeoutMs

    while (Date.now() < deadline) {
      if (exited) {
        return setState(app.id, { status: 'crashed', port: null, proc: null, error: exitInfo })
      }

      // The announced port takes priority: if the server told us where it is,
      // that is authoritative over the port we hoped it would use.
      for (const port of [announcedPort, assignedPort]) {
        if (port && (await canConnect(port))) {
          return setState(app.id, { status: 'ready', port, error: undefined })
        }
      }

      await sleep(POLL_INTERVAL_MS)
    }

    signal(proc, 'SIGTERM')
    return setState(app.id, {
      status: 'crashed',
      port: null,
      proc: null,
      error: `Timed out after ${Math.round(readyTimeoutMs / 1000)}s waiting for the server to listen`,
    })
  }

  async function ensureStarted(app) {
    // Static apps have nothing to spawn — the gateway serves them off disk.
    if (app.type === 'static') {
      return publicState(setState(app.id, { status: 'ready', port: null, error: undefined }))
    }

    const current = states.get(app.id)
    if (current?.status === 'ready') return publicState(current)
    if (current?.pending) return publicState(await current.pending)

    const pending = start(app)
    setState(app.id, { pending })
    try {
      return publicState(await pending)
    } finally {
      const after = states.get(app.id)
      if (after) states.set(app.id, { ...after, pending: null })
    }
  }

  /** Signal the whole process group, falling back to the direct child. */
  function signal(proc, sig) {
    try {
      process.kill(-proc.pid, sig)
    } catch {
      try {
        proc.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }

  async function stop(id) {
    const state = states.get(id)
    const proc = state?.proc

    if (proc && proc.exitCode === null && proc.signalCode === null) {
      signal(proc, 'SIGTERM')
      const deadline = Date.now() + STOP_GRACE_MS
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) {
        await sleep(50)
      }
      if (proc.exitCode === null && proc.signalCode === null) signal(proc, 'SIGKILL')
    }

    setState(id, { status: 'stopped', port: null, proc: null, pending: null })
  }

  async function stopAll() {
    await Promise.all([...states.keys()].map(stop))
  }

  return { ensureStarted, stop, stopAll, get, states }
}

export const __testing = { userPath, freePort, osType: os.type }
