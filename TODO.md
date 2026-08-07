# TODO

Everything known to be outstanding, in one place. Ordered by what would bite a
user first, not by how interesting it is to build.

Architecture and rationale live in [DESIGN.md](./DESIGN.md); this file is only
the ledger.

---

## Shipped

- **M1 — the mechanic.** Gateway, hostname routing, registry, supervisor.
- **M2 — the desktop.** Canvas, icons, draggable/resizable windows, dock.
- **M3 — supervision.** Lifecycle, readiness detection, log capture, crash panel
  with real stderr.
- **M4 — ⌘K.** Generation from a description, plus Fix with AI on the crash panel.
- **Linked apps.** Any folder on disk, run in place.
- **Any-language servers.** `type: "server"` is a shell command with `$PORT`, so
  the "Python runtime" item from the original plan is closed — Python, Go, or a
  binary all work today.

---

## Unverified claims

Things asserted in the design that have not actually been demonstrated. These
matter more than the feature gaps below, because they could invalidate a
decision rather than just leave one unmade.

- **Vite has never been run through the gateway.** The whole reason the gateway
  is HTTP rather than an `app://` protocol is that Vite's HMR needs a WebSocket.
  The upgrade relay is proven end to end — but against `apps/clock`, which
  hand-rolls its WebSocket. A real Vite app was planned for M1 and swapped out
  to avoid an `npm install` in the test path. Until one runs, two risks are
  open: Vite's `server.allowedHosts` may reject the forwarded `Host` header, and
  its HMR client may build a WebSocket URL that does not survive proxying.
  **This should be the next thing done.**
- **Nobody has looked at the desktop.** All UI verification has been through
  Electron harnesses and log inspection; `screencapture` needs a permission the
  agent shell lacks. Layout, spacing, and visual polish are unreviewed.

---

## Papercuts

- **API key comes only from the environment.** Launch from Finder or the Dock and
  both ⌘K and Fix fail, because the app inherits no `ANTHROPIC_API_KEY`. Same
  class of problem as the PATH issue the supervisor already solves. Wants a
  config file in `userData` read at startup.
- **`keepAlive` is parsed but not enforced.** Closing a window stops a server app
  immediately; the warm-hold TTL in the manifest does nothing.
- **Window layout is not persisted.** Position and size are lost on relaunch,
  though the design calls for storing them.
- **Emoji icons.** Fine at desk scale, but a full desktop of them reads like a
  Slack channel list. See DESIGN.md §12.

---

## Security

- **Apps are served without their own CSP.** A generated or linked app can still
  load remote code. The desktop shell is locked down; the app frames are not.
  This wants closing before generated apps become routine.
- **Electron version currency is a dependency, not hygiene.** The per-app-iframe
  model means iframe-origin CVEs land directly on this design — the audit that
  prompted the 34 → 43 upgrade included *"Permission Check Handler Receives Main
  Frame Origin Instead of Requesting Iframe Origin"*. Treat `npm audit` findings
  against Electron as load-bearing.
- **Threat model is "apps I or my agent wrote."** Not hostile third-party code.
  If that changes, revisit iframes vs `WebContentsView` (DESIGN.md §2).

---

## Not built yet

- **M5 — edit live.** Side-by-side app + chat, folder watch, hot reload. The
  generator and fixer already exist; this is the loop around them.
- **The `desktop.*` SDK bridge.** `desktop.storage`, `desktop.ai`, `desktop.window`
  — designed in DESIGN.md §7, no code yet. `desktop.ai` is the notable one: it
  lets generated apps call a model without the user pasting a key into each app.
- **Pop-out to native windows.** Canvas-first was chosen with an escape hatch for
  multi-monitor; the hatch does not exist.
- **Intents and the shared store.** The part that makes apps compose rather than
  coexist, and the long-term reason this is a shell and not a launcher.

---

## Housekeeping

- **Machine-local state is unbacked-up.** `links.json` and generated apps live in
  `userData/`, outside the repo — so a clone does not restore your desktop.
  Linked projects already carry their own `desktop.json`; the list itself does not.
- **`type: "node"` is a legacy alias** normalised in `manifest.js`. Harmless, but
  it can go once nothing depends on it.
- **`npm test` is 177 tests and growing.** The two Electron suites must be run
  separately (`test:electron`, `test:electron:ui`) and are easy to forget in CI.
