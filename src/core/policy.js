/**
 * What a manifest declaration grants: device access for framed apps, and the
 * AI key for spawned servers. The rule is the same everywhere — absent from
 * the manifest means denied.
 *
 * An app lives in an iframe on its own origin, and Permissions Policy defaults
 * `microphone` and `camera` to `self` — the *parent's* origin. So a framed app
 * is denied the microphone before any prompt is shown: getUserMedia rejects
 * with NotAllowedError and there is nothing the user can click to change it.
 * The frame has to carry an `allow` attribute naming the feature.
 *
 * That attribute is generated from what the manifest declared, so the rule
 * stays the same as every other permission here: absent means denied.
 *
 * Two gates, and both have to open — this module answers both:
 *   1. Permissions Policy, via the iframe `allow` attribute  (framePolicy)
 *   2. Chromium's own permission request, via Electron        (allowsMedia)
 */

/** Manifest permission -> Permissions Policy feature. Order fixes the output. */
const FRAME_FEATURES = [
  ['mic', 'microphone'],
  ['camera', 'camera'],
]

/** The `allow` attribute for an app's iframe. Empty string means grant nothing. */
export function framePolicy(permissions = []) {
  const declared = new Set(permissions)
  return FRAME_FEATURES.filter(([name]) => declared.has(name))
    .map(([, feature]) => feature)
    .join('; ')
}

/**
 * The spawn environment for an app, with AI access decided by the manifest.
 *
 * An app that declared `ai` gets `ANTHROPIC_API_KEY` — the resolved key, which
 * prefers Settings over the shell so a pasted key works from a Dock launch. An
 * app that declared nothing gets the variable *removed*, because the desktop
 * itself may have inherited the user's key from a terminal and `...process.env`
 * would otherwise hand it to every app on the shelf.
 */
export function withAiGrant(env, permissions = [], apiKey = null) {
  const out = { ...env }
  delete out.ANTHROPIC_API_KEY
  if (apiKey && new Set(permissions ?? []).has('ai')) out.ANTHROPIC_API_KEY = apiKey
  return out
}

/**
 * Whether to grant a Chromium `media` permission request. `mediaTypes` is what
 * Electron reports the page asked for — every part must have been declared, and
 * a request naming nothing (screen capture) is granted by neither permission.
 */
export function allowsMedia(permissions = [], mediaTypes = []) {
  if (!mediaTypes.length) return false

  const declared = new Set(permissions)
  return mediaTypes.every(
    (type) =>
      (type === 'audio' && declared.has('mic')) || (type === 'video' && declared.has('camera')),
  )
}
