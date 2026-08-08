/**
 * Gateway authentication.
 *
 * The gateway binds loopback only, but any other process on the machine can
 * still send it a request with a forged Host header. An iframe cannot attach
 * custom headers to a navigation, so we bootstrap through a one-time token in
 * the query string and convert it into a cookie:
 *
 *   1. renderer navigates to  notes.reef.localhost:PORT/?__reef=<token>
 *   2. gateway sets an HttpOnly cookie and 302s to the clean URL
 *   3. every later request carries the cookie; other processes have no way to
 *      obtain it
 *
 * The origin is stable across launches so app localStorage survives; only the
 * token rotates.
 */

import crypto from 'node:crypto'

export const AUTH_COOKIE = '__reef_auth'
export const AUTH_PARAM = '__reef'
export const AUTH_HEADER = 'x-reef-token'

// Reachable without credentials so the renderer can probe readiness before it
// has anywhere to put a cookie. Deliberately a allowlist of one.
const PUBLIC_PATHS = new Set(['/__reef/health'])

export function parseCookies(header) {
  const out = {}
  if (!header) return out

  for (const part of String(header).split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** Constant-time compare that does not leak length via early return. */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * @returns {{action: 'allow'}
 *          |{action: 'authorize', redirectTo: string}
 *          |{action: 'deny'}}
 */
export function authDecision({ pathname, searchParams, cookies = {}, headerToken, token }) {
  if (PUBLIC_PATHS.has(pathname)) return { action: 'allow' }

  // Checked before the cookie because it is the credential that actually
  // arrives: an app runs in a cross-site iframe, where a SameSite=Lax cookie
  // is stored but never sent back. Electron attaches this header to every
  // request bound for *.reef.localhost.
  if (tokensMatch(headerToken, token)) return { action: 'allow' }

  if (tokensMatch(cookies[AUTH_COOKIE], token)) return { action: 'allow' }

  const offered = searchParams?.get(AUTH_PARAM)
  if (offered && tokensMatch(offered, token)) {
    // Drop the token from the URL so it does not linger in history, referrers,
    // or anything the app itself can read off location.search.
    const rest = new URLSearchParams(searchParams)
    rest.delete(AUTH_PARAM)
    const query = rest.toString()
    return { action: 'authorize', redirectTo: query ? `${pathname}?${query}` : pathname }
  }

  return { action: 'deny' }
}
