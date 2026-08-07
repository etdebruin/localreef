/**
 * Reading a port back out of a dev server's stdout.
 *
 * We inject PORT when spawning, but not every framework honours it — Vite in
 * particular ignores the environment and uses `server.port` (default 5173),
 * while Next.js does honour it. So stdout sniffing is a co-primary readiness
 * strategy, not a fallback: whichever of the two resolves first wins.
 *
 * Only loopback hosts count. A line about fetching a dependency over the
 * network must never be mistaken for the server coming up.
 */

// ANSI SGR colour codes, which dev servers emit around the URL they print.
// Built from a char code rather than written as a regex literal: an ESC byte
// in source is invisible, easy to mangle in a copy/paste, and trips
// no-control-regex.
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(ESC + '\\[[0-9;]*m', 'g')

const LOOPBACK_PORT =
  /(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]):(\d+)/

export function sniffPort(line) {
  if (!line) return null

  const match = String(line).replace(ANSI, '').match(LOOPBACK_PORT)
  if (!match) return null

  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return port
}
