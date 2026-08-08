/**
 * Per-app capture of console errors from app frames.
 *
 * Every app iframe shares the shell's webContents, so main hears one stream of
 * console-message events for the whole desktop. This sorts that stream into a
 * small ring buffer per app — keyed by the frame's `*.reef.localhost` origin —
 * so a fix or edit turn can hand the model the actual failure instead of
 * leaving it to deduce one from "the button doesn't work".
 *
 * Deliberately errors-only: warnings and logs are what apps say when nothing
 * is wrong, and a fix prompt wants signal.
 */

import { parseHostname } from './routing.js'

function appIdFromUrl(url) {
  if (!url) return null
  try {
    return parseHostname(new URL(url).host)
  } catch {
    return null
  }
}

/** The tail of a source URL, for a compact "where": index.html:212. */
function sourceRef(sourceUrl, line) {
  if (!sourceUrl) return null
  let file
  try {
    // A trailing slash is the document itself, which the gateway serves from
    // index.html — name the file the model can actually open.
    file = new URL(sourceUrl).pathname.split('/').pop() || 'index.html'
  } catch {
    file = sourceUrl
  }
  return line != null ? `${file}:${line}` : file
}

const isError = (level) => level === 'error' || level === 3

export function createConsoleCapture({ limit = 20 } = {}) {
  /** id -> [{ text, count }] */
  const buffers = new Map()

  function record({ level, message, frameUrl, sourceUrl, line } = {}) {
    if (!isError(level)) return null

    // The frame is authoritative; the script URL is the legacy-signature
    // fallback. Anything not on an app origin is the shell's own noise.
    const id = appIdFromUrl(frameUrl) ?? appIdFromUrl(sourceUrl)
    if (!id) return null

    const where = sourceRef(sourceUrl, line)
    const text = where ? `${String(message)} (${where})` : String(message)

    const buffer = buffers.get(id) ?? []
    buffers.set(id, buffer)

    // A render loop throwing per frame is one fact, not a flood.
    const last = buffer[buffer.length - 1]
    if (last?.text === text) {
      last.count += 1
      return id
    }

    buffer.push({ text, count: 1 })
    if (buffer.length > limit) buffer.shift()
    return id
  }

  function recent(id) {
    return (buffers.get(id) ?? []).map((e) => (e.count > 1 ? `${e.text} (×${e.count})` : e.text))
  }

  function clear(id) {
    buffers.delete(id)
  }

  return { record, recent, clear }
}
