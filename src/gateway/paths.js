/**
 * Turning a request path into a file on disk, safely.
 *
 * The URL path is untrusted: it comes from the browser, and in the agent flow
 * the model writes app content that may link to arbitrary paths. Everything
 * here assumes hostile input.
 */

import path from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

export function contentType(filename) {
  return TYPES[path.extname(String(filename)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * @returns absolute path inside `root`, or null if the request escapes it.
 */
export function safeResolve(root, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(String(urlPath))
  } catch {
    // Malformed percent-encoding. A 400 would also be defensible; treating it
    // as "no such file" avoids telling a prober anything.
    return null
  }

  // A NUL can truncate the path at the syscall boundary, making a checked
  // path and an opened path disagree.
  if (decoded.includes('\0')) return null

  const withIndex = decoded.endsWith('/') ? `${decoded}index.html` : decoded

  // Resolve first, judge second. Normalising before resolving would collapse a
  // leading "/.." against the filesystem root and quietly turn an escape into
  // an innocent-looking path.
  const rootAbs = path.resolve(root)
  const target = path.resolve(rootAbs, `.${withIndex}`)

  const rel = path.relative(rootAbs, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  return target
}
