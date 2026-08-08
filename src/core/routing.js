/**
 * Hostname -> app id.
 *
 * Every app lives on its own origin under `*.colony.localhost`, which is what
 * buys us storage partitioning and cross-app isolation for free. This function
 * is the only thing standing between a Host header and the app registry, so it
 * refuses anything it does not fully recognise.
 */

const SUFFIX = '.colony.localhost'

// Deliberately strict: no dots (so no nested subdomains), no dot-segments, no
// separators. An id that gets past this is safe to use as a lookup key.
const APP_ID = /^[a-z0-9][a-z0-9-]*$/

function stripPort(host) {
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

export function parseHostname(host) {
  if (!host) return null

  const hostname = stripPort(String(host)).toLowerCase()
  if (!hostname.endsWith(SUFFIX)) return null

  const id = hostname.slice(0, -SUFFIX.length)
  if (!id || !APP_ID.test(id)) return null

  return id
}
