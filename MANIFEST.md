# Local Reef app format

An app is a folder. **The manifest is optional** — Local Reef infers what it can, and you
only write `reef.json` to override something it got wrong or to declare a capability.

An app that works in Local Reef still runs standalone outside it. That's a constraint, not a
nice-to-have: it's what keeps these from being locked into the shell.

---

## Inference rules

Applied in order; first match wins.

| Condition | Type | Behavior |
|---|---|---|
| `index.html` present, no `package.json` | `static` | Gateway serves the folder. No process. |
| `package.json` with a `dev` script | `server` | Spawn `<pm> run dev`, proxy to it |
| `package.json` with `start` but no `dev` | `server` | Spawn `<pm> start`, proxy to it |
| `index.html` present, `package.json` has no dev/start script | `static` | Serve `dist/` if it exists, else the root |
| none of the above | — | Registration fails with a message naming what's missing |

`<pm>` is detected from the lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
`bun.lockb` → bun, otherwise npm.

---

## `reef.json`

Every field is optional.

```json
{
  "name": "Notes",
  "icon": "📝",
  "type": "static",
  "root": "dist",
  "run": "npm run dev",
  "env": { "DATABASE_URL": "sqlite:./notes.db" },
  "keepAlive": 300,
  "window": { "width": 720, "height": 560, "resizable": true },
  "permissions": ["storage", "ai", "net:api.github.com"],
  "intents": ["add:link"]
}
```

| Field | Default | Notes |
|---|---|---|
| `name` | folder name, title-cased | Shown under the icon and in window chrome |
| `icon` | generated bubble | Emoji, or a path to an image in the folder. See below. |
| `type` | inferred | `static` \| `server`. Set it to override inference. |
| `root` | `dist` if present, else `.` | Static only — directory to serve |
| `run` | inferred from `package.json` | Server only — the spawn command. `$PORT` is expanded. |
| `port` | assigned automatically | Only for servers that hardcode their port and ignore `PORT` |
| `env` | `{}` | Merged over Local Reef's injected vars (below) |
| `keepAlive` | `300` | Seconds to stay warm after the last window closes. `0` = stop immediately, `-1` = never stop. |
| `window` | `{ width: 800, height: 600, resizable: true }` | Initial geometry; user resizes are persisted and win afterward |
| `permissions` | `[]` | See below |
| `intents` | `[]` | Verbs this app handles; used by ⌘K routing (v1.5) |

### Icons

An icon is always a circular bubble. What you declare decides what fills it:

```json
{ "icon": "icon.png" }   // the art, edge to edge
{ "icon": "📝" }          // the emoji, on a neutral tile
{}                        // a tile tinted from the app id, with initials
```

Image paths are relative to the app folder, may be `.png` `.svg` `.jpg` `.webp`
`.gif` `.avif` `.ico`, and are capped at **512 KB**. A path that points outside the
app folder, or a file that will not load, falls back to a generated bubble — a
broken icon never leaves a blank circle.

You do not need to supply anything. The generated bubble is a real icon, not a
placeholder: hue is derived from the app id and held at a fixed lightness and
chroma, so a desktop of them looks like a set.

### Injected environment (node apps)

```
PORT             assigned ephemeral port
HOST             127.0.0.1
REEF_APP_ID      "notes"
REEF_DATA_DIR    ~/Library/Application Support/Local Reef/data/notes
REEF             "1"
```

Bind to `HOST`, not `0.0.0.0`. If your framework ignores `PORT` (Vite does), Local Reef
adopts whatever port your server prints to stdout instead — you don't have to do
anything, but honoring `PORT` makes startup faster and more reliable.

### Any language, not just Node

`run` is just a shell command, so anything that serves HTTP works — Python,
Go, Ruby, a compiled binary. Set `type` to `server` and give it a command that
honours `$PORT`:

```json
{
  "name": "Underscore",
  "icon": "🎚️",
  "type": "server",
  "run": "uv run uvicorn app:create_app --factory --host 127.0.0.1 --port $PORT"
}
```

If the server hardcodes its port and cannot be told otherwise, declare it
instead and Local Reef will look for it there:

```json
{ "type": "server", "run": "./serve", "port": 8765 }
```

`type: "node"` still works and means the same as `server`.

---

## Permissions

Absent from the manifest means denied. Local Reef prompts on first use and remembers the
answer.

| Permission | Grants |
|---|---|
| `storage` | `reef.storage.*` — per-app persisted KV |
| `ai` | `reef.ai.complete()` — model access through Local Reef's key, rate-limited |
| `notify` | `reef.notify()` |
| `net:<host>` | Outbound fetch to that host. Repeat per host. `net:*` is allowed but always prompts. |
| `shared` | Read/write the cross-app store (v1.5) |

No permission is needed to talk to the app's own origin.

---

## Examples

**Static, zero config** — just a folder:

```
notes/
  index.html
  app.js
  style.css
```

Nothing else required. Drops onto the desktop and opens instantly.

**Static with an icon and AI access:**

```json
{ "icon": "📝", "permissions": ["storage", "ai"] }
```

**Vite dev server:**

```
chart/
  package.json      ← has a "dev" script
  vite.config.js
  src/
```

Also zero config. Local Reef spawns it, adopts the port Vite prints, and proxies WebSocket
upgrades so HMR works.

**Node server needing an override:**

```json
{
  "name": "Feed Reader",
  "icon": "📡",
  "run": "node server.js",
  "keepAlive": -1,
  "permissions": ["storage", "net:*"]
}
```

`keepAlive: -1` because it polls in the background and should stay resident.

---

## Reserved paths

The gateway owns `/__reef/*` on every app origin and will shadow anything you put
there:

| Path | Serves |
|---|---|
| `/__reef/sdk.js` | The SDK bridge |
| `/__reef/vendor/*` | Local React, etc. — no CDN, works offline |
| `/__reef/health` | Gateway readiness probe |
