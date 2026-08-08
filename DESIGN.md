# Local Desktop

A desktop for local apps.

You open Local Desktop and see a desktop with icons on it. You click one and your app opens
in a window. No terminal, no `npm run dev`, no remembering whether the notes thing
was on 5173 or 3000. Apps are addressed by identity, not URL. And when you want a
new one, you press ⌘K and describe it.

---

## 1. The core problem

People are building a lot of small local apps now. Each one is a folder that needs
a server started, a port remembered, a tab kept alive. Forty apps means forty
islands and a mental index of port numbers.

Local Desktop's premise: **the shell is the address bar.** An app is `notes`, not
`localhost:5173`. Everything below follows from making that true without the app
having to know or care.

---

## 2. Decisions locked

| | |
|---|---|
| Shell | Electron |
| Windowing | Canvas-first (in-window frames) with pop-out to native |
| Frames | `<iframe>` on per-app origins |
| Runtimes | Static folders + any server (`run` is a shell command with `$PORT`) |
| AI | Generation ships in v1 |

**Why Electron over Tauri.** We're spawning Node child processes regardless, so the
runtime-weight argument is moot. Electron's session/preload/protocol handling and
process supervision story is mature. We care about experience, not megabytes.

**Why iframes over `WebContentsView`.** `WebContentsView` gives stronger isolation
but composites *above* the renderer's DOM within its rect — which means fighting it
for drop shadows, overlapping z-order, and minimize animations. The canvas *is* the
product, so compositing wins. With a distinct origin per app, a strict CSP, and no
node integration, iframes are respectably sandboxed. Revisit if we ever run
untrusted third-party apps.

---

## 3. Addressing: the gateway

The obvious design is a custom protocol (`app://notes/`). **It doesn't work**, and
the reason drives the whole architecture: Chromium custom schemes don't support
WebSocket upgrade. Vite HMR is a WebSocket. Since "the agent edits your app while
you watch it reload" is a headline feature, we need WS.

So: **one local HTTP gateway**, hostname-routed.

```
                             ┌───────────────────────────────────────────┐
  iframe                     │  Local Desktop gateway   127.0.0.1:PORT   │
  notes.desktop.localhost ──▶│                                           │
                             │  static app  ──▶  serve from disk         │
                             │  server app  ──▶  proxy + WS              │──▶ 127.0.0.1:51823
                             └───────────────────────────────────────────┘         (child proc)
```

- **Static apps**: gateway serves files straight off disk. No process, no spawn,
  instant launch.
- **Server apps**: gateway proxies (including `Upgrade`) to the child's ephemeral
  port. The port exists; it never surfaces.

Same address either way. The app folder stays portable — it still runs standalone
outside Local Desktop.

### Why `*.desktop.localhost`

Distinct origin per app (free storage partitioning, free cross-app isolation), and
Chromium treats `.localhost` as a secure context, so apps get `crypto.subtle`,
service workers, and everything else gated on HTTPS — without a certificate.

Don't rely on the system resolver. Pin it:

```js
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.desktop.localhost 127.0.0.1')
```

That makes resolution a hard guarantee rather than a DNS behavior we're hoping for.

### Gateway auth

The gateway binds loopback only, but any local process can send a request with a
`Host:` header, so requests need a credential.

**The cookie handshake this section originally specified does not work.** The plan
was: navigate to `?__desktop=<token>`, set an `HttpOnly` cookie, redirect to a clean
URL. The cookie is set correctly — and then never sent back. An app iframe is a
*cross-site* context relative to the `file://` renderer, and `SameSite=Lax` cookies
are withheld on cross-site nested-frame navigations. Every app 401s on the redirect.

What works: Electron attaches an `x-desktop-token` header to every request bound for
`*.desktop.localhost` via `webRequest.onBeforeSendHeaders`, scoped by URL filter so
it cannot leak elsewhere, and the gateway strips it before forwarding so app servers
never see it. The cookie and query-param paths remain as fallbacks.

This was caught only by an Electron harness (`test/electron/iframe-auth.mjs`); the
unit tests set `Cookie` directly and so bypassed browser policy entirely.

**And the header filter has to name `ws://` and `wss://`.** A `*` scheme in a Chrome
match pattern covers http and https only, so the original
`*://*.desktop.localhost/*` never matched a WebSocket handshake: the upgrade arrived
at the gateway with no credential and was destroyed. Since WebSocket support is the
entire reason this is an HTTP gateway rather than a custom protocol, that quietly
removed the point of the design — HMR was dead in the real app while `test:vite`
stayed green, because that harness attaches the header itself. Same lesson as the
cookie, one layer down: a Node client is not a browser.

Origin persists across sessions, so app `localStorage` survives. Token rotates per
Local Desktop launch.

---

## 4. What an app is

A folder. **The manifest is optional**, because "I don't have to think about it" is
the entire pitch. Infer first:

```
index.html, no package.json      → static
package.json with a dev script   → node server
```

Manifest only to override. Full format in [MANIFEST.md](./MANIFEST.md).

Apps arrive three ways: generated by the agent (into `~/…/Local Desktop/apps/`), drag-dropped
as a folder (registered by path, stays where it is), or cloned from a git URL.

### Readiness detection is two strategies, not one

We spawn with `PORT` and `HOST=127.0.0.1` injected — but **Vite ignores `PORT`** and
uses `server.port` (default 5173). Next.js honors it. So we run both:

1. Poll TCP connect on the port we assigned
2. Scan stdout for a printed URL (`Local: http://localhost:5173`) and adopt whatever
   port it announces

Whichever resolves first wins. Both are probed on **both loopback families** —
a server told to listen on `localhost` binds whichever the resolver returns
first, and on modern macOS that is `::1`. Vite does this, so probing only
127.0.0.1 makes it look permanently dead. The family that answered is recorded
and the gateway proxies to it. 30s timeout, because a cold `npm install` may run
first.

### Two environment gotchas worth designing around now

**PATH.** A GUI-launched Electron app on macOS does *not* inherit your shell's PATH,
so `node` and `npm` are simply missing. Resolve PATH once at boot by spawning a login
shell, cache it, use it for every child process. Long-term: bundle a Node binary so
Local Desktop works on a machine with no Node at all — that's the difference between "it just
works" and "it just works if you're already a developer."

**Dependencies.** `package.json` present and no `node_modules` → run install before
start, with progress surfaced in the launching state. Detect the package manager from
the lockfile.

### Icons: one geometry, three contents

An icon is always a square tile — same size, same corner, same shadow. Only what
sits inside varies:

| Declared | Renders as |
|---|---|
| a file in the app folder (`icon.png`, `logo.svg`) | the art, edge to edge |
| an emoji | the emoji on a **neutral** tile |
| nothing | a tile tinted from the app id, carrying the name's initials |

Holding the geometry fixed is the whole trick. The original worry — that a desktop
of emoji reads like a Slack channel list — was really about *inconsistency*: emoji,
bare letters and art all at different visual weights, each supplying its own shape.
Fixing the frame and letting only the contents change makes a mixed set read as one
family.

Generated tiles vary **hue only**; lightness and chroma are constants in CSS
(`oklch(0.62 0.15 <hue>)`). Equal perceived weight across the set is what separates
"designed" from "randomly coloured". The hue comes from an FNV-1a hash of the id
with a golden-angle stride, so sibling ids like `app1`/`app2` land far apart.

Icon files ride to the renderer as data URIs, so they are capped at 512 KB and
resolved through the gateway's path confinement — the path comes out of a manifest
the user or the model wrote, so it is untrusted. A path that escapes the app folder,
or a file that will not load, falls back to a generated tile rather than a blank
square.

---

## 5. Lifecycle

```
registered ──▶ resolving ──▶ starting ──▶ ready ──▶ idle ──▶ stopped
   (deps)         (spawn)     (probe)              (TTL)
                                 │
                                 ▼
                              crashed ──▶ [restart] [fix with AI]
```

- Static apps jump straight to `ready` — there's nothing to start.
- Keep-warm TTL after the last window closes (default 5 min, `keepAlive` in manifest).
- Restart with exponential backoff, capped.
- **Crash surfaces the actual stderr in the frame**, not a white screen. That panel
  is where "fix this" lives, and it's the moment the AI stops being a gimmick.

---

## 6. Window management

The desktop renderer owns layout. Each window is `{ id, appId, x, y, w, h, z, state, title }`
persisted to SQLite, so your desk looks the way you left it.

Three problems worth naming up front, because they're where naïve implementations fall
over:

**Dragging.** The iframe swallows pointer events mid-drag. Fix: a transparent
full-canvas shield div that appears on drag/resize start and disappears on end, with
window-level pointer listeners.

Pointer capture on the titlebar was tried and **removed**. It silently failed to
bind, so drags stopped working entirely, and it also routed `pointerup` away from the
close button — which is why the X did nothing. A drag must additionally ignore
`pointerdown` originating on a control inside the handle.

**Focus.** Clicking into a cross-origin iframe doesn't tell the parent anything, so
z-order can't update. Unfocused windows get a transparent click-catcher; the first
click focuses and removes it. Costs one click on an unfocused window — which is what
Windows does anyway, and is acceptable.

**Pop-out.** Creates a `BrowserWindow` on the same origin, so `localStorage` and
session state carry over intact. Pop-out *moves* the window rather than duplicating it —
one app, one live frame.

---

## 7. The SDK bridge

Apps opt in with one script tag; the gateway serves it on every app origin:

```html
<script src="/__desktop/sdk.js"></script>
```

**Transport is a preload, not `postMessage`.** All app frames load in a dedicated
session partition (`persist:desktop-apps`) carrying a preload that exposes
`window.__desktop_bridge`. Registered via `session.registerPreloadScript`, it applies to
iframes *and* popped-out `BrowserWindow`s — one code path for both. The main process
derives app identity from the requesting frame's origin, so an app can't claim to be
another app.

v1 surface:

```js
desktop.app.id                  // "notes"
desktop.app.setTitle(str)       // window chrome
desktop.app.setIcon(emoji)

desktop.window.close()
desktop.window.setSize(w, h)

desktop.storage.get(key)        // per-app KV, persisted, capability-gated
desktop.storage.set(key, value)

desktop.notify(message)         // native notification

desktop.ai.complete(prompt)     // ← the sleeper feature
```

`desktop.ai` is worth more than it looks. Apps the agent generates can themselves call a
model **without the user ever pasting an API key into an app**. Mediated by the main
process, rate-limited, capability-gated per app. A folder of localhost apps can never
offer this.

---

## 8. The AI layer

### Generation (⌘K)

```
⌘K → "a tool to track my running mileage"

  ▸ scaffolding…
  ▸ writing app.jsx…
  ▸ 🏃 icon appears, shimmers, opens
```

**Default output is a single-file static HTML app.** Zero install, zero process,
instant launch, trivially editable, tiny crash surface. Escalate to a Node server only
when the app genuinely needs one (secrets, filesystem access, long-running work). This
choice is what makes the demo *fast*, and speed is most of the magic.

No CDN — the CSP blocks external hosts and we want apps to work offline. The gateway
serves a local vendor bundle on every app origin, so generated apps can
`import React from '/__desktop/vendor/react'`.

### Model configuration

Claude Opus 5 (`claude-opus-5`), $5/$25 per MTok, 1M context.

```ts
const runner = client.beta.messages.toolRunner({
  model: 'claude-opus-5',
  max_tokens: 64000,
  output_config: { effort: 'xhigh' },   // best setting for coding/agentic work
  tools: [writeFile, readFile, listFiles, finish],
  messages,
  stream: true,                          // required at this max_tokens
})

for await (const stream of runner) {
  for await (const event of stream) { /* drive the ⌘K progress panel */ }
}
```

Notes that matter:

- **Thinking is on by default on Opus 5** — omitting the field runs adaptive. Don't
  pass `budget_tokens`; it's removed and returns 400. Same for `temperature` / `top_p`.
- `max_tokens` caps thinking *plus* output together, hence 64k.
- **Handle `stop_reason: "refusal"` before reading `content`** — it's an HTTP 200 with
  an empty or partial content array, so `content[0].text` throws. Opt into
  `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) so a declined request
  is re-served automatically instead of just failing.
- Prompt-cache the system prompt + SDK docs. Opus 5's minimum cacheable prefix is 512
  tokens, so even a modest system prompt caches.
- The tool set is **scoped to the app's own folder**. Every path is resolved to
  canonical form and rejected if it escapes the root — the model writes the path, so
  the path is untrusted input.

### Editing live

Right-click an app → **Edit**: app running on the left, chat on the right. For static
apps the gateway watches the folder and pushes a frame reload on change, so edits
appear in under a second. That tight loop is the thing people will actually keep
Local Desktop open for.

### Intents (v1.5, but design for it now)

Apps declare intents they handle (`add:link`, `open:file`, `play:track`). ⌘K routes:
*"save this to my reading list"* finds whichever app claims `add:link`. Combined with a
shared SQLite store behind a capability gate, apps compose. **This is the only part of
the design that a folder of separate localhost apps can never replicate** — it's the
long-term reason Local Desktop exists rather than being a nicer launcher.

---

## 9. Storage layout

```
~/Library/Application Support/Local Desktop/
  desktop.db              apps, windows, layout, intents, shared store
  apps/<id>/           agent-generated apps
  data/<id>/           per-app sandboxed data (also DESK_DATA_DIR for servers)
  logs/<id>.log        rolling stderr/stdout
```

Linked apps (drag-dropped) are registered by absolute path and stay where they are.

---

## 10. Security model

| Boundary | Mechanism |
|---|---|
| App ↔ app | Distinct origins; storage partitioned by the browser |
| App ↔ host | Preload bridge only; no node integration; capability-gated |
| App ↔ network | Strict CSP, allowlist per manifest |
| Gateway ↔ other local procs | Loopback bind + rotating session cookie |
| Child servers | Bound `127.0.0.1` only, never `0.0.0.0` |
| Agent ↔ filesystem | Tool paths canonicalized and confined to the app root |

The threat model for v1 is "apps I or my agent wrote" — not hostile third-party code.
Say so explicitly rather than implying a sandbox we haven't earned.

---

## 11. Build order

*Status as built: M1–M4 done, M5 not started. Current ledger: [TODO.md](./TODO.md).*

**M1 — The mechanic works.** Gateway + resolver pin + registry. Two sample apps: one
static, one Vite. Click an icon, it opens, HMR works. No canvas yet.

**M2 — The desktop.** Canvas, icons, window frames, drag shield, focus handling, dock,
persisted layout. This is where it starts to feel like a product.

**M3 — Supervision.** Full lifecycle state machine, dependency bootstrap, log capture,
crash panel with real stderr.

**M4 — ⌘K.** Agent bar, generation into `apps/`, streaming progress, icon materialize,
auto-open. Plus "fix this" on the crash panel.

**M5 — Edit live.** Side-by-side edit mode, folder watch, hot reload.

Then: pop-out, `desktop.ai`, intents, shared store. (Python arrived early —
`type: "server"` is just a shell command, so any language already works.)

---

## 12. Open questions

- **Multi-window per app.** Currently one live frame per app. Two views of the same
  notes app is a reasonable want, and the window model would need to change to support it.
- **Sync.** Apps are folders and data is SQLite, so git-backing the whole desktop is
  plausible. Out of scope for v1, but don't paint into a corner.
- **Bundled Node.** Deferred to post-v1, but it's the line between "works for
  developers" and "works."
