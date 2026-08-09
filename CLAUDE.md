# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                  # launch the desktop (Electron)
npm test                   # 349 unit + integration tests
npm run lint
npm run test:electron      # iframe auth, needs a real Electron GUI
npm run test:electron:ui   # dock/window/settings, edit pane, hello, session restore
npm run test:electron:ws   # browser-initiated WebSocket from an app iframe
npm run test:electron:media # mic/camera Permissions Policy on an app iframe
npm run test:electron:console # app-frame errors reach main, attributed per app
npm run test:electron:storage # app localStorage survives a real relaunch
npm run test:vite          # real Vite through the gateway, incl. live HMR
npm run shot               # screenshot the running app into .shots/
npm run install:mac        # rebuild Local Reef.app into /Applications, if stale
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
routes through one loopback HTTP server on `*.reef.localhost`, which also
buys per-app origins (storage partitioning for free) and secure-context APIs,
since Chromium treats `.localhost` as trustworthy.

Resolution is pinned with `host-resolver-rules` rather than trusting the system
resolver to honour RFC 6761.

### Auth is a header, not a cookie

`AUTH_HEADER` (`x-reef-token`) is injected by Electron via
`webRequest.onBeforeSendHeaders`, scoped to `*.reef.localhost`, and stripped
before forwarding so app servers never see it.

**The filter must list `ws://` and `wss://` explicitly.** A `*` scheme in a
Chrome match pattern means http or https and *nothing else*, so
`*://*.reef.localhost/*` never matched a WebSocket handshake. Every app's
upgrade reached the gateway with no credential and was destroyed — the clock
sample sat on "disconnected — retrying" and Vite HMR was dead in the real app
while `test:vite` stayed green, because that harness sets the header itself.
`test/electron/iframe-websocket.mjs` guards it; run it with
`HTTP_ONLY_FILTER=1` to watch the old filter fail.

**Do not "simplify" this back to the cookie.** An app iframe is a cross-site
context relative to the `file://` renderer, so a `SameSite=Lax` cookie is set
and then never sent back — every app 401s. The cookie and `?__reef=` param
paths remain as fallbacks. `test/electron/iframe-auth.mjs` exists solely to
guard this.

## Traps that have already cost time

**The gateway port is identity, not plumbing.** An app's origin is
`<id>.reef.localhost:<port>`, and localStorage keys to the full origin — so
`listen(0)` gave every launch a new port and stranded every app's data under
the previous origin. A real user lost a day's entries to this. The port is
pinned and persisted (`gatewayPort` in settings, default 7333); never "fix" a
port conflict by falling back to another port, that re-ships the data loss
silently. Related: the single-instance lock means `npm start` and the Dock
app no longer run side by side — the second launch focuses the first.
`test/electron/iframe-storage.mjs` guards it across a real process restart;
`REEF_STORAGE_DRIFT=1` demonstrates the loss.

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

**`npm start` and the app in the Dock are different code.** `/Applications/Local
Reef.app` is a packaged copy of `src/`, so a fix verified from source is still
absent from the Dock until the bundle is rebuilt — which already cost one full
round of "still broken after restart" on the microphone bug. `npm run
install:mac` rebuilds and replaces it, and exits silently in ~0.2s when nothing
under `src/` or `apps/` has changed. A Stop hook in `.claude/settings.local.json`
runs it automatically. When verifying anything a user will hit from the Dock,
drive the packaged binary: every harness here takes `REEF_APP_BIN`.

**A framed app has no microphone unless the frame says so.** Permissions Policy
defaults `microphone` and `camera` to `self` — the *parent's* origin — so an app
on `*.reef.localhost` inside the `file://` renderer is denied the device before
any prompt exists. `getUserMedia` rejects with `NotAllowedError: Permission
denied` and no amount of clicking "allow" helps; it looks like a macOS or
gateway problem and is neither. `src/core/policy.js` turns the manifest's `mic`
and `camera` into the iframe's `allow` attribute *and* into Electron's
permission-request answer — both gates have to open.
`test/electron/iframe-media.mjs` guards it; run it with `DECLARE=0` to watch an
undeclared app lose the feature. Asserting the attribute is not enough — the
test asks the frame itself via `document.featurePolicy.allowsFeature`.

**FSEvents lies twice at watcher start.** `fs.watch(dir, {recursive:true})` on
macOS replays a beat of *pre-watch* history the moment the stream opens — the
folder's own creation, files written before launch — and separately can report
events with a `null` filename or the watched directory's own basename.
`src/main/watcher.js` swallows the settle window after `watch()` and treats
anonymous events as ignorable; without both, every frame reloaded the moment
it opened. Tests must use `watchSettled()` (see `test/watcher.test.js`).

**Window content swaps go through `win.stage`, never `win.body`.** The body is
a row holding the stage plus (for a ⌘K-built app) the edit chat sidecar. A
`replaceChildren` on the body deletes the chat; `showState()` and the iframe
swap all target the stage. The `.state` overlay anchors to the stage too.

**Provenance is where the folder lives, not what it claims.** `generated: true`
is tagged in `refreshApps()` off the `userData/apps` scan — there is no marker
file, so a copied folder can't claim it and a linked folder shadowing the same
id loses it. The edit chat is gated on it in **main** (`apps:edit` refuses),
not only in the renderer; the fixer's confirm-click covers `linked` and
`discovered` both.

**Edit conversations are text turns only, capped, in memory.** Tool_use and
thinking blocks are never replayed across turns; the files on disk are the
state and each turn's prompt carries a fresh listing. History dies with the
window — `apps:stop` is the single teardown hook (the renderer calls it for
every window close, static apps included).

**A minimized window reads `offset*` as 0.** It is `display: none`, where every
offset property is 0 — persisting those would wipe the window's real geometry
the moment it was parked. Session persistence reads the inline `style.left/top/
width/height` instead, which survive being hidden.
`test/electron/session-restore.mjs` guards it.

**A click inside an app iframe never reaches the shell.** The event dies in
the frame's own (cross-origin) document, so a back window could not be raised
by clicking its content — only its titlebar. Each window carries a `.catcher`
overlay that CSS shows *only while the window is unfocused* (`.window.focused
.catcher { display:none }`); it intercepts that first click in the parent
document, focuses the window, then vanishes so the focused app pays no pointer
tax. Assert the effect (which window paints over the overlap, via
`elementFromPoint`), not the class.

**Full screen is class-only, never inline geometry.** `.window.maximized`
fills the canvas through CSS `!important`, leaving the inline
`left/top/width/height` as the untouched restore target — un-maximizing is
just dropping the class. The green expand bubble and a titlebar double-click
both toggle it; `maximized` rides in the session like `minimized`. A DOM
`dblclick` needs a *two-click* `sendInputEvent` sequence (second click
`clickCount:2`) — a single down/up pair never fires it.

**On macOS, closing the shell window must not shut the shell down.** The red
dot hides; gateway and supervisor stay up, and the renderer rebuilds the
desktop from `userData/session.json` on the next window. `window-all-closed`
used to call `shutdown()`, which left reactivation pointing at a dead gateway.
Quit (`before-quit`) is still the real teardown.

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
- `test:electron:media` asks a real framed page what Permissions Policy grants
  it. Nothing in Node can answer that: the policy is applied by the browser to
  a cross-origin frame, and the iframe served fine over HTTP the whole time the
  microphone was silently denied.
- `test:electron:console` throws an uncaught exception inside a real app
  iframe and asserts it reaches main's `console-message` with a frame URL that
  attributes it to the app. The fix/edit prompts' console evidence rests
  entirely on Chromium forwarding frame console output with `details.frame` —
  if that stops, the capture records nothing and prompts silently get worse.

The pattern behind all four: **assert the effect a user sees, not the mechanism
you just wrote.** Minimize shipped broken because its test asserted
`el.hidden === true` — the state the code sets — while `display: flex` kept the
window fully on screen. Measure the bounding box, the HTTP status, the pixels.

Do not delete either suite as duplication.

## Agent generation

Models are chosen per task in `MODELS` (`agent.js`): generation, fixing, and
the edit chat run `claude-opus-5` — all three edit real files, so wrong costs
more than slow — and the future ⌘K intent router is pinned to
`claude-haiku-4-5`. Haiku rejects
`output_config.effort`, so the effort setting is derived from the model
(`outputConfig()`), not hardcoded. `max_tokens: 32000`, `effort: 'high'` on
Opus, streaming required. Tuning that was arrived at empirically:

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
