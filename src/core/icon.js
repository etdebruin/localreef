/**
 * App icons.
 *
 * An icon is always a square tile, in exactly one of three modes:
 *
 *   image     the manifest points at a file in the app folder — it fills the
 *             tile edge to edge, because the art *is* the icon
 *   emoji     the manifest gives an emoji — centred on a neutral tile, so the
 *             emoji's own colours carry the identity without fighting a
 *             coloured background
 *   generated nothing was declared — a tile tinted from the app's id, with
 *             the name's initials on it
 *
 * The geometry never varies. What varies is what sits inside it, which is
 * what stops a dock of mixed apps looking like a pile of stickers (DESIGN.md
 * §4: "a desktop of emoji looks like a Slack channel list").
 */

import fs from 'node:fs/promises'

import { contentType, safeResolve } from '../gateway/paths.js'

/**
 * Icons ride to the renderer inside an IPC payload as a data URI, so they have
 * to stay small. An app wanting something bigger than this does not want an
 * icon.
 */
const MAX_ICON_BYTES = 512 * 1024

/** Extensions we will put in an <img>. Anything else is not an icon. */
const IMAGE_EXTENSIONS = ['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico']

export function isImageIcon(icon) {
  const text = String(icon ?? '').trim().toLowerCase()
  if (!text) return false
  return IMAGE_EXTENSIONS.some((ext) => text.endsWith(ext))
}

/**
 * One letter for a single word, two for a phrase. More than two stops being
 * legible at dock size.
 */
export function initialsFor(name) {
  const words = String(name ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return words
    .slice(0, 2)
    .map((word) => word.slice(0, 1))
    .join('')
    .toUpperCase()
}

/**
 * A stable hue per app id.
 *
 * FNV-1a: cheap, and it avalanches well enough that `app1` and `app2` land far
 * apart rather than adjacent. Only the hue is derived — lightness and chroma
 * are fixed in CSS, so every generated tile carries identical visual weight and
 * the set reads as one family instead of a bag of random colours.
 */
export function hueFor(id) {
  const text = String(id ?? '')
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // FNV prime, via shifts to stay in 32-bit integer space.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  // Golden-angle stride spreads sequential hashes around the wheel instead of
  // letting them bunch, which matters because real ids are often near-siblings.
  return Math.round(((hash % 360) * 137.508) % 360)
}

/**
 * Load a manifest-declared icon file as a data URI, or null.
 *
 * The path comes out of `colony.json`, which the user or the model wrote, so
 * it is untrusted: it is resolved through the same confinement the gateway
 * uses for request paths and rejected if it leaves the app folder.
 */
export async function readIconImage(dir, icon) {
  if (!isImageIcon(icon)) return null

  const file = safeResolve(dir, `/${String(icon).replace(/^\.?\/*/, '')}`)
  if (!file) return null

  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return null

    const data = await fs.readFile(file)
    return `data:${contentType(file)};base64,${data.toString('base64')}`
  } catch {
    // Missing, unreadable, or a directory. A broken icon path is not worth
    // failing the app over — it falls back to a generated tile.
    return null
  }
}
