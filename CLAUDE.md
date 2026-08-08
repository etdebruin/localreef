# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                  # launch the desktop (Electron)
npm test                   # 225 unit + integration tests
npm run lint
npm run test:electron      # iframe auth, needs a real Electron GUI
npm run test:electron:ui   # dock/window/settings via real Chromium input events
npm run test:electron:ws   # browser-initiated WebSocket from an app iframe
npm run test:vite          # real Vite through the gateway, incl. live HMR
npm run shot               # screenshot the running app into .shots/
```

**You can see the app — use it.** `npm run shot` drives the real desktop over
the Chrome DevTools Protocol and has it photograph its own page, so it needs no
macOS screen-recording grant and no test-only code in `src/main`.
`npm run shot -- dock settings` captures named states only; the list is in
`scripts/shot.mjs`. Look at the output before claiming a UI change works. The
first run found emoji icons that were invisible against their own tiles, and a
clock stuck on "disconnected — retrying" that turned out to be **every** app's
WebSocket silently failing.

Run one test file: `node --test test/gateway.test.js`
Run one test by name: `node --test --test-name-pattern 'websocket' test/gateway.test.js`

**Node 26 dropped the bare-directory form.** `node --test test/` fails with
`Cannot find module`; the glob in the `test` script is required.

`npm start` inherits the shell environment, so ⌘K generation only works when
launched from a terminal that has `ANTHROPIC_API_KEY`. Launching from Finder or
the Dock gives no key.

## What this is

A desktop shell for local apps. Apps are addressed by identity (`notes`), never
by URL (`localhost:5173`). Click an icon and the app opens in a window; the
shell owns starting servers and assigning ports.

`DESIGN.md` holds the architecture and the reasoning behind each decision.
`MANIFEST.md` is the app format spec. `TODO.md` is the ledger of what is
outstanding — including unverified claims, which is where to look first. Read
`DESIGN.md` before changing the gateway, supervisor, or window model.

## Architecture

Four pieces, wired together in `src/main/index.js`:

| Layer | Owns |
|---|---|
| `src/core/` | Pure logic — inference, manifest, routing, slug, links, registry. No I/O beyond `fs`. |
| `src/gateway/` | One local HTTP server fronting every app: hostname routing, auth, static serving, proxying, WebSocket relay. |
| `src/main/supervisor.js` | Process lifecycle: spawn, readiness, crash capture, teardown. |
| `src/main/agent.js` | ⌘K generation. Model writes files through a toolset confined to one app folder. |

The renderer (`src/renderer/`) owns icon layout and window management only; it
reaches main through the preload bridge in `src/main/preload.cjs`.

### The gateway is an HTTP server, not a custom protocol

`app://notes/` was the original design and **does not work**: Chromium custom
schemes cannot carry a WebSocket, and Vite HMR is a WebSocket. Everything
routes through one loopback HTTP server on `*.desktop.localhost`, which also
buys per-app origins (storage partitioning for free) and secure-context APIs,
since Chromium treats `.localhost` as trustworthy.

Resolution is pinned with `host-resolver-rules` rather than trusting the system
resolver to honour RFC 6761.

### Auth is a header, not a cookie

`AUTH_HEADER` (`x-desktop-token`) is injected by Electron via
`webRequest.onBeforeSendHeaders`, scoped to `*.desktop.localhost`, and stripped
before forwarding so app servers never see it.

**The filter must list `ws://` and `wss://` explicitly.** A `*` scheme in a
Chrome match pattern means http or https and *nothing else*, so
`*://*.desktop.localhost/*` never matched a WebSocket handshake. Every app's
upgrade reached the gateway with no credential and was destroyed — the clock
sample sat on "disconnected — retrying" and Vite HMR was dead in the real app
while `test:vite` stayed green, because that harness sets the header itself.
`test/electron/iframe-websocket.mjs` guards it; run it with
`HTTP_ONLY_FILTER=1` to watch the old filter fail.

**Do not "simplify" this back to the cookie.** An app iframe is a cross-site
context relative to the `file://` renderer, so a `SameSite=Lax` cookie is set
and then never sent back — every app 401s. The cookie and `?__desktop=` param
paths remain as fallbacks. `test/electron/iframe-auth.mjs` exists solely to
guard this.

## Traps that have already cost time

**Upgraded sockets escape `closeAllConnections()`.** After an HTTP upgrade Node
detaches the socket from the server's tracked list, but `getConnections()` still
counts it — so `server.close()` waits forever. The gateway tracks upgraded
sockets in its own `Set`. Any new server in this repo that accepts upgrades
needs the same treatment (see the backend fixture in `test/gateway.test.js`).

**Servers may bind IPv6 loopback only.** `listen(port, 'localhost')` binds
whichever family the resolver returns first, and on modern macOS that is `::1`.
Vite does exactly this. Readiness therefore probes both `127.0.0.1` and `::1`,
records which one answered as `state.host`, and **the gateway must proxy to that
host** — any `lookup()` passed to `createGateway` has to thread `host` through
alongside `port`, or a working app 502s.

**Vite ignores `PORT`.** It uses `server.port` (default 5173); Next.js honours
`PORT`. Readiness therefore runs two strategies concurrently — TCP probe on the
assigned port, and sniffing stdout for an announced loopback port — and takes
whichever answers first. Removing either breaks a real framework.

**GUI-launched Electron has no shell PATH**, so `node`/`npm`/`uv` are missing.
`supervisor.js` resolves PATH once from a login shell and caches it.

**Spawned apps need their own process group.** `npm start` is really
`sh → npm → node`; signalling the shell orphans the process holding the port.
Children spawn `detached: true` and are signalled as a group.

**`type` is `static` or `server`.** `server` means "spawn a shell command and
proxy it" — any language. `node` is a legacy alias normalised in
`manifest.js`; don't reintroduce Node-specific assumptions.

**Control characters do not survive being written into source.** A literal ESC
or NUL gets mangled. Build them with `String.fromCharCode` (see
`src/core/probe.js` and the null-byte case in `test/paths.test.js`).

## Testing

TDD is the working style here: write the test, watch it fail, then implement.

The Electron suites are not redundant with `npm test` — **they cover what the
plain suite structurally cannot**, and two shipped bugs prove it:

- `npm test` sets the `Cookie` header directly via `http.request`, bypassing
  browser cookie policy entirely. That is how the iframe 401 shipped green.
- UI tests must drive `sendInputEvent`, never `element.click()`. A programmatic
  click dispatches straight to the element and skips the pointer sequence, so it
  passes happily while a button is broken by pointer routing.
- `test:vite` runs a real Vite dev server. A hand-rolled WebSocket sample stood
  in for it for a long time and hid two bugs: IPv6-only binding, and `host` not
  being threaded to the proxy.
- `test:electron:ws` opens a WebSocket from a real page. Every other suite
  drives the gateway from Node and sets the auth header on the handshake by
  hand, so all of them proved the gateway *relays* an authorised upgrade and
  none proved a browser ever sends one. It did not.

The pattern behind all four: **assert the effect a user sees, not the mechanism
you just wrote.** Minimize shipped broken because its test asserted
`el.hidden === true` — the state the code sets — while `display: flex` kept the
window fully on screen. Measure the bounding box, the HTTP status, the pixels.

Do not delete either suite as duplication.

## Agent generation

`claude-opus-5`, `max_tokens: 32000`, `output_config: { effort: 'high' }`,
streaming required. Tuning that was arrived at empirically:

- 64k tokens at `xhigh` effort made the request long enough that the socket died
  with undici `terminated`. `max_tokens` caps thinking *and* output together.
- The stream's events must be **drained**, not just awaited via
  `finalMessage()` — that keeps the socket reading through a long generation.
- `stop_reason: "refusal"` arrives as an HTTP **200**. Check it before touching
  `content`, or `content[0]` throws.

Generated apps are written to `userData/apps/`, never into this repo's `apps/`.
A failed or refused run deletes the folder rather than leaving a broken icon.

`createFixer` repairs an existing app and is deliberately separate from
`createGenerator`. Generation owns the folder it created and deletes it on
failure; a fix operates on a folder that is already the user's — for a linked
app it is their real project checkout. **A fix must never delete anything**, and
the UI takes a second confirming click before editing a linked folder.

## Where apps come from

Three sources, merged in `refreshApps()`:

1. `apps/` in this repo — the bundled samples
2. `userData/apps/` — anything ⌘K generated
3. `userData/links.json` — folders linked in place from anywhere on disk

Linked folders are read where they live; nothing is copied. `apps/notes` is the
static sample, `apps/clock` the server sample — it hand-rolls a WebSocket
specifically so the proxy and upgrade relay are provable with no `npm install`.
