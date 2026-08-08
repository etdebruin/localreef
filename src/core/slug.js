/**
 * Deriving an app id from a description.
 *
 * The id becomes a hostname label (`<id>.reef.localhost`) and a folder
 * name, so it has to be short, lowercase, and pass the router's own check.
 * The pretty name lives in reef.json and can be anything.
 */

const MAX_WORDS = 3
const MAX_LENGTH = 40

// Words that carry no meaning in "make me a tool that ..." phrasing.
const FILLER = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'my', 'me', 'i', 'that', 'this',
  'with', 'and', 'or', 'in', 'on', 'is', 'it', 'app', 'tool', 'make',
  'create', 'build', 'simple', 'little', 'small', 'some', 'please',
])

export function slugify(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((word) => !FILLER.has(word))
    .slice(0, MAX_WORDS)

  const id = words.join('-').slice(0, MAX_LENGTH).replace(/-+$/, '')

  // Anything that would not survive parseHostname falls back rather than
  // producing an app that cannot be reached.
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : 'app'
}

export function uniqueId(base, taken = []) {
  const used = taken instanceof Set ? taken : new Set(taken)
  if (!used.has(base)) return base

  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}
