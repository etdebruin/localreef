/**
 * The startup hello.
 *
 * Pure text selection — the renderer decides when and how to show it. Time of
 * day picks the register; the name, when we have one, makes it personal. Kept
 * in core so the wording is testable without a window.
 */

const PARTS = [
  { from: 5, to: 11, key: 'morning' },
  { from: 12, to: 16, key: 'afternoon' },
  { from: 17, to: 21, key: 'evening' },
]

const TITLES = {
  morning: (name) => (name ? `Good morning, ${name}` : 'Good morning'),
  afternoon: (name) => (name ? `Good afternoon, ${name}` : 'Good afternoon'),
  evening: (name) => (name ? `Good evening, ${name}` : 'Good evening'),
  night: (name) => (name ? `Up late, ${name}?` : 'Up late?'),
}

const SUBS = {
  morning: 'The reef is waking up with you.',
  afternoon: 'Welcome back — the reef kept everything just as you left it.',
  evening: 'The reef settles in for the evening.',
  night: 'The reef is quiet at this hour.',
}

/**
 * A bad clock must never crash the first paint, so anything outside 0–23 —
 * including NaN — just reads as night, the segment with no daytime claim.
 */
export function greetingFor(name, hour) {
  const who = String(name ?? '').trim()
  const part = PARTS.find((p) => hour >= p.from && hour <= p.to)?.key ?? 'night'
  return { title: TITLES[part](who), sub: SUBS[part] }
}
