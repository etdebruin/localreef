# Local Desktop

A desktop for local apps. Click an icon, your app opens — no terminal, no
`npm run dev`, no remembering which port anything is on.

Apps are addressed by identity, not URL: `notes`, never `localhost:5173`.

```
npm install
npm start
```

Two sample apps ship in `apps/`:

| App | Type | Proves |
|---|---|---|
| **Notes** 📝 | static | serves instantly off disk, no process at all; `localStorage` persists per app origin |
| **Clock** ⏱ | node server | spawned on click, proxied through the gateway, live **WebSocket** frames |

---

## Building an app by describing it

Press **⌘K**, describe what you want, hit Enter:

```
⌘K → "a pomodoro timer with session history"

  ✓ wrote index.html
  ✓ wrote desktop.json
  ✓ Built pomodoro-timer-session      → 🍅 icon appears, opens
```

Takes roughly two minutes. The result is a single self-contained `index.html`
with no build step and no install, so it opens the moment it exists.

Needs `ANTHROPIC_API_KEY` in the environment. Generated apps are written to
`~/Library/Application Support/Local Desktop/apps/`, never into this repo — so
`apps/` stays yours.

The model writes files through a toolset confined to that one app folder;
paths that try to escape it are refused, and a run that fails or is declined
removes the folder rather than leaving a broken icon behind.

---

## When an app breaks

The crash panel shows the real stderr, not a blank window — and a **Fix with
AI** button. It reads the app's files plus the failure, edits them in place, and
relaunches. Repairs are deliberately minimal: it fixes the failure rather than
redesigning the app.

For a **linked** project the folder is your actual checkout, so the button names
the path and takes a second, explicit click before touching anything. A fix
never deletes files, even when it fails.

---

## Running a project you already have

Drag its folder onto the desktop. Nothing is copied — the folder stays where it
is, so editing it in your editor edits what the desktop runs.

Most projects need no configuration. One that does — a Python FastAPI app whose
own entrypoint hardcodes a port — needs a four-line `desktop.json` in its root:

```json
{
  "name": "Underscore",
  "icon": "🎚️",
  "type": "server",
  "run": "uv run uvicorn underscore.server:create_app --factory --host 127.0.0.1 --port $PORT --env-file .env"
}
```

`run` is a shell command with `$PORT` expanded, so any language works.

---

## Adding your own app

Drop a folder into `apps/`. There is usually nothing to configure — Local
Desktop works out what it is:

```
apps/my-thing/
  index.html            → static app, served straight off disk
```

```
apps/my-thing/
  package.json          → with a "dev" or "start" script: spawned and proxied
```

Add a `desktop.json` only to override something. Every field is optional:

```json
{
  "name": "Feed Reader",
  "icon": "📡",
  "run": "node server.js",
  "keepAlive": -1
}
```

Full format: [MANIFEST.md](./MANIFEST.md). Architecture and the reasoning
behind it: [DESIGN.md](./DESIGN.md).

### What your server app gets

```
PORT             a free port, assigned for you
HOST             127.0.0.1
DESKTOP_APP_ID   "my-thing"
DESKTOP          "1"
```

Bind to `HOST`, not `0.0.0.0`. If your framework ignores `PORT` — Vite does —
Local Desktop reads the port out of your server's startup output instead, so
it works either way.

---

## How it works

One local HTTP gateway fronts every app and routes on the hostname:

```
notes.desktop.localhost  ──▶  gateway  ──▶  files on disk
clock.desktop.localhost  ──▶  gateway  ──▶  127.0.0.1:51823  (spawned process)
```

Each app gets its own origin, so storage and cookies are partitioned by the
browser rather than by anything we wrote. The gateway is an HTTP server rather
than a custom `app://` protocol for one concrete reason: Chromium custom
schemes cannot carry a WebSocket, and WebSockets are how HMR works.

Requests are authenticated with a per-launch token that becomes an `HttpOnly`
cookie, so other processes on your machine can't reach your apps by forging a
`Host` header.

---

## Development

```
npm test                # 180 tests, including end-to-end against the real samples
npm run lint
npm run test:electron   # iframe auth in a real Electron window
npm run test:electron:ui # window drag/close via real Chromium input events
```

The two Electron suites are separate because they need a real GUI — and they
exist because the plain suite structurally cannot catch what they cover. It
sets the `Cookie` header directly with `http.request`, which bypasses browser
cookie policy; that is exactly how a bug shipped where every app iframe got a
401. The UI suite drives `sendInputEvent` rather than `element.click()`, since
a programmatic click skips the pointer sequence and would pass happily while
the close button was broken.

The end-to-end suite starts the real `apps/clock` server, proxies it, and
asserts live WebSocket frames arrive — so a green run means the actual stack
works, not just the units.

---

## Status

Milestones 1–4 are done: registry, supervisor, gateway, the desktop, ⌘K
generation, and Fix with AI. Apps in any language run via `type: "server"`, and
projects anywhere on disk can be linked in place.

Outstanding work — including one unverified architectural claim worth reading
before trusting the design — is tracked in [TODO.md](./TODO.md).
