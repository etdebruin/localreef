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
- **Settings.** A scanned projects folder (opt-in per app via `desktop.json`) and
  an API key stored in `userData`, so ⌘K works launched from Finder or the Dock.
- **Dock and window controls.** Dock replaces canvas icons; minimize parks a
  window without stopping the app, × still quits it.
- **Square app icons.** One geometry, three contents — supplied art, an emoji on
  a neutral tile, or a hue-tinted tile with initials. Closes the icon-design
  open question in DESIGN.md §4.
- **Any-language servers.** `type: "server"` is a shell command with `$PORT`, so
  the "Python runtime" item from the original plan is closed — Python, Go, or a
  binary all work today.
- **Vite verified end to end** (`npm run test:vite`): page proxied, HMR
  WebSocket connected, live `full-reload` delivered after a file edit. Neither
  feared risk materialised — no host-check rejection, and the HMR client's URL
  survives proxying. Two *unforeseen* bugs did: Vite binds IPv6 loopback only,
  and `host` was not threaded to the proxy.

---

## Unverified claims

Things asserted in the design that have not actually been demonstrated. These
matter more than the feature gaps below, because they could invalidate a
decision rather than just leave one unmade.

- **Nobody has looked at the desktop.** All UI verification has been through
  Electron harnesses and log inspection; `screencapture` needs a permission the
  agent shell lacks. Layout, spacing, and visual polish are unreviewed.

---

## Papercuts

- **`keepAlive` is parsed but not enforced.** Closing a window stops a server app
  immediately; the warm-hold TTL in the manifest does nothing.
- **Window layout is not persisted.** Position, size and minimized state are lost
  on relaunch, though the design calls for storing them.

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
- **`npm test` is 180 tests and growing.** Three suites must be run separately
  (`test:electron`, `test:electron:ui`, `test:vite`) and are easy to forget in
  CI — they are also the ones that have caught the worst bugs.
