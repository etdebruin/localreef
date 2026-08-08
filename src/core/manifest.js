/**
 * Folder + inference + optional reef.json -> the record the rest of Local Reef uses.
 *
 * Inference supplies the defaults; the manifest only ever overrides. Nothing
 * downstream should have to ask whether a field was inferred or declared.
 */

const DEFAULT_WINDOW = { width: 800, height: 600, resizable: true }
const DEFAULT_KEEP_ALIVE = 300

function titleCase(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Everything that is not static is just "a server we spawn and proxy". The
 * original name for that was "node", which was wrong the moment a Python or
 * Go app showed up — the supervisor only ever runs a shell command. "node" is
 * still accepted so existing manifests keep working.
 */
function normaliseType(type) {
  if (type === 'node') return 'server'
  return type ?? null
}

export function resolveManifest({ folderName, inferred = {}, manifest = {} }) {
  const type = normaliseType(manifest.type ?? inferred.type)

  return {
    id: String(folderName).toLowerCase(),
    name: manifest.name ?? titleCase(folderName),
    icon: manifest.icon ?? null,

    type,
    // A static app has nothing to spawn, even if inference guessed a command
    // before an explicit `type: "static"` overrode it.
    run: type === 'static' ? null : (manifest.run ?? inferred.run ?? null),
    root: manifest.root ?? inferred.root ?? '.',
    // For servers that hardcode their port and ignore the one we inject.
    port: manifest.port ?? null,

    env: { ...(manifest.env ?? {}) },
    // `??` rather than `||` so keepAlive: 0 (stop immediately) survives.
    keepAlive: manifest.keepAlive ?? DEFAULT_KEEP_ALIVE,
    window: { ...DEFAULT_WINDOW, ...(manifest.window ?? {}) },

    permissions: [...(manifest.permissions ?? [])],
    intents: [...(manifest.intents ?? [])],
  }
}
