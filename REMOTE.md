# Remote access

*Status: designed, not built. Architecture context in [DESIGN.md](./DESIGN.md).*

Your reef, on your phone. Apps keep running on the Mac; the phone is a window
onto them. This document exists because every other shape of "Local Reef on
mobile" fails structurally, and the reasons are worth recording before anyone
re-derives them.

---

## 1. The phone is a client, not a host

Three worlds were considered:

**Run apps on the phone.** Dead on arrival. The shell's job is spawning
processes — `sh → npm → node`, process groups, PATH resolution — and iOS
forbids spawning interpreters outright. Android technically allows it via
Termux, on the platform most hostile to long-lived background processes. The
only portable subset is static apps, which is a launcher, not Local Reef.

**Dockerize and publish.** The moment a build-and-push step and a remote host
exist, we have reinvented a PaaS and lost the core premise: click an icon, the
shell owns the server, "deploy" is not a concept. Rejected on identity grounds,
not feasibility.

**Phone as a viewport onto the Mac.** The architecture already did the hard
part: every app — static or server — fronts through one gateway. Nothing about
the supervisor, readiness, or app lifecycle changes. The gateway grows a second
face; the phone talks to it. This is the design.

---

## 2. Transports: three tiers, none mandatory

The customer must not be required to install anything. Tailscale is an
accelerant for people who have it, never a prerequisite.

| Tier | Reaches | Setup | Secure context |
|---|---|---|---|
| **LAN** (v1) | same Wi-Fi | scan a QR code | no (plain HTTP) |
| **Tailnet** (v1.5) | anywhere | user already runs Tailscale | yes, via `tailscale serve` |
| **Reef Relay** (future) | anywhere | scan a QR code | yes, real certs |

**LAN is the default and needs zero third parties.** Enabling remote access in
Settings opens listeners bound to the LAN interface, shows a QR code, done.
Same-network-only is an honest v1 limitation; it covers "phone on the couch,
Mac in the office," which is most of the want.

**Tailscale is detected, not demanded.** If a tailnet interface exists, bind it
too and offer `tailscale serve` for TLS. One settings toggle, no new concepts.

**Reef Relay is the eventual consumer answer** — the Plex/Home Assistant model.
The desktop keeps an outbound tunnel to a first-party relay; the phone hits
`https://<name>.reef.app`. Zero setup, works from anywhere, real certificates,
and subdomain-per-app origins come back. It is deliberately last: it costs
infrastructure and money, and the LAN tier proves the product before the relay
pays for it. The relay must be a dumb pipe (SNI passthrough, certificates held
by the desktop via DNS-01) so "local" stays true: the relay moves bytes it
cannot read.

Everything below is transport-agnostic. The listeners, pairing, and hub are
identical across tiers; only the interface they bind changes.

---

## 3. Addressing: ports, not hostnames

`*.reef.localhost` cannot leave the machine — browsers hairpin `.localhost` to
loopback before DNS is ever consulted. The remote face needs a different origin
scheme, and the options rank clearly:

**Path prefixes (`/a/notes/…`) — rejected.** Breaks every absolute path an app
serves (`/index.css` collides across apps), breaks per-app storage
partitioning, and forces apps to know they are behind a prefix — which violates
"the app folder stays portable."

**Wildcard public DNS (`notes.reef.192-168-4-22.sslip.io`) — rejected as the
default.** Clever, zero-setup, preserves subdomain origins — and quietly broken
on exactly the networks customers have: home routers with DNS-rebind protection
refuse public DNS answers that contain private addresses. A default that fails
depending on router firmware is not a default. (It also needs internet to
resolve a purely local address, which is absurd on its face.)

**Port per app — chosen.** The remote face runs one small listener per app plus
one for the hub, on stable ports persisted alongside the registry. The browser
treats `192.168.4.22:4601` and `:4602` as distinct origins, so `localStorage`
and IndexedDB stay partitioned per app with no DNS involvement at all. Routing
becomes "which listener received this" instead of Host-header parsing — the
remote face must in fact *ignore* Host for routing and reject unexpected values
outright, as belt-and-braces against DNS rebinding.

Identity addressing is preserved where it matters: nobody types these URLs. The
hub shows icons; a tap navigates. The port is as invisible on the phone as it
is on the desktop.

The desktop face is untouched — `.reef.localhost`, Host routing, header auth,
all exactly as today. The remote face reuses the gateway's serving, proxying,
and upgrade-relay internals; only resolution differs. Every new listener that
accepts upgrades needs its own tracked-socket `Set`, per the
`closeAllConnections()` trap.

---

## 4. Auth: pair once, one cookie, every port

Cookies are host-scoped but **port-blind** (RFC 6265): a cookie set at
`192.168.4.22:4600` rides along to every other port on that host. For subdomain
origins that would be a flaw; for port-per-app it is the design gift — **pair
once at the hub, and the credential is automatically presented on every app
port**, because every port is the same gateway. No per-app handshake, no token
in any app URL, and `?__reef=` never appears on a phone.

**Pairing.** Settings → Remote → "Pair a device" shows a QR encoding
`http://<ip>:<hub-port>/__reef/pair?code=<one-time>`. The phone scans, the
gateway exchanges the code for a device token and sets it as an `HttpOnly`
cookie, then lands on the hub. The code is 128-bit random, single-use, expires
in 90 seconds, and the endpoint only accepts codes while the pairing pane is
open on the desktop. Failures are rate-limited per source address. Compare with
the existing constant-time `tokensMatch`.

**Devices, not a token.** The desktop's `x-reef-token` rotates per launch,
which is correct for a machine-internal secret and useless for a phone that
must survive restarts. Remote credentials are per-device records —
`{ id, name, secretHash, createdAt, lastSeen }` — persisted in `userData`, listed
in Settings with a revoke button. Only a hash is stored; the secret lives in
the phone's cookie jar.

**`authDecision` grows one clause.** Header token (desktop), then device-cookie
lookup (remote), then the existing param bootstrap (desktop fallback). Device
cookies are only honoured on remote listeners; the loopback face never accepts
them, so a revoked phone cannot be replayed against the desktop face.

**Strip the cookie before proxying.** The gateway already strips
`x-reef-token` so app servers never see a credential. The remote face must do
the same for the auth cookie — port-blind cookies mean every app server would
otherwise receive the device secret on every request.

**Why this survives the browser policies that burned us before.** The iframe
401 and the WebSocket-filter bug both came from cross-site contexts. The phone
has neither: apps open as **top-level navigations** (one app at a time — a
phone has no window canvas), so the cookie is first-party and `SameSite=Lax`
sends it; a WebSocket opened by the page is same-origin, so the handshake
carries it too. No header injection exists on the phone and none is needed.
Safari's third-party-cookie blocking never engages because nothing is ever
framed.

DNS rebinding falls out for free: a hostile page re-resolved to the Mac's
address sends requests whose cookies belong to the *hostile* host, so they
arrive credential-less and 401. Cross-app CSRF over the shared cookie (app A
scripting requests at app B's port) is real but sits inside the stated threat
model — "apps I or my agent wrote" — and is noted for the day that changes.

---

## 5. The hub

The phone never sees the desktop renderer — it is `file://` Electron with a
preload, and a window canvas is meaningless on a phone anyway. The remote face
serves a **hub**: a static page owned by the gateway, a grid of the same icons
the desktop shows (they already travel as data URIs), one tap to open an app.

The hub needs main-process cooperation the gateway does not have today.
`createGateway` currently takes `{ token, lookup }`; the remote face adds a
capability object injected from main:

```
remote: {
  listApps()        → registry entries + icon data + per-app remote port
  openApp(id)       → ensure started (supervisor), resolve when ready
  devices / pairing → the records in §4
}
```

Tap flow for a server app: hub calls `openApp`, the supervisor spawns and
probes readiness exactly as a desktop click does, the hub navigates to the
app's port when ready — the launching state is the hub's spinner rather than
the desktop's shimmer. Static apps navigate immediately.

**Lifecycle.** A remote-opened app has no desktop window, so nothing ever
"closes" it. This finally forces the `keepAlive` TTL (parsed but unenforced —
see TODO) to be real: remote opens take a lease, renewed by traffic, and the
supervisor reaps on expiry. The Mac must be awake and Local Reef running; a
headless menu-bar mode is deliberately out of scope here and belongs to the
relay tier's design.

A web app manifest on the hub makes "Add to Home Screen" produce a real icon —
the reef looks like an app on the phone because it is one.

---

## 6. What plain HTTP costs, and saying so

The `.localhost` secure-context trick is loopback-only. On the LAN tier there
is no TLS, so framed-web platform features gated on secure contexts are gone:
`getUserMedia` (mic/camera), `crypto.subtle`, service workers, clipboard API.

The manifest already declares `mic` and `camera`, so the hub can be honest:
apps that need a device the transport cannot deliver render dimmed, with the
reason — "needs a secure connection; available over Tailscale or Relay." An
app that *silently* depends on `crypto.subtle` will just break; generated apps
should prefer non-subtle paths where trivial, and the crash panel story covers
the rest.

**No custom CA on the phone, ever.** Installing a trust profile to get LAN TLS
is a security footgun handed to exactly the audience least equipped to assess
it, and the friction defeats the zero-setup point. Secure contexts are what the
Tailscale and Relay tiers are *for*.

---

## 7. Security model delta

New row for the table in DESIGN.md §10:

| Boundary | Mechanism |
|---|---|
| Gateway ↔ local network | Opt-in listeners (off by default), per-device tokens with revocation, rate-limited pairing, Host allowlist, auth cookie stripped before proxying |

Child app servers still bind `127.0.0.1` only — the remote face proxies to
them, so enabling remote access exposes exactly one surface: the gateway.
macOS will show the "accept incoming connections" firewall prompt the first
time; the settings pane should say so before the OS does.

---

## 8. Build order

**R1 — LAN, static apps.** Remote listeners, pairing + device records, the
hub, port persistence. Static apps need no supervisor coupling, so this ships
the whole security surface with the smallest moving part.

**R2 — Server apps.** `openApp` through the supervisor, readiness in the hub,
the `keepAlive` lease. HMR over the relay proves WS end to end.

**R3 — Tailscale tier.** Interface detection, optional `tailscale serve` for
TLS, secure-context features light up.

**R4 — Relay.** Separate design doc when its time comes; nothing in R1–R3 may
assume its absence or presence.

## 9. Testing

The lesson that runs through this codebase — *a Node client is not a browser* —
applies with new force: the phone is a browser we do not control, with no
header injection and no preload. The remote suite must therefore drive a real
browser context with **no** Electron help against a real LAN listener:

- Pairing: scan-equivalent navigation with a valid code lands authenticated on
  the hub; a reused or expired code lands on a 401, measured by status.
- The cookie rides to an app port and a WebSocket opened from the app page
  connects — the `test:electron:ws` lesson, re-proven for the cookie path.
- A revoked device's next request 401s on every port.
- An undeclared-mic app is dimmed in the hub; `document.featurePolicy` has
  nothing to say over HTTP and the test must not pretend otherwise.

Assert effects — statuses, connected sockets, rendered hub state — not
mechanism.
