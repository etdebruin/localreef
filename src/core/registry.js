/**
 * Turning folders on disk into app records.
 *
 * A folder that cannot be understood is still returned, carrying an `error`
 * explaining why. The desktop shows it as a broken icon rather than silently
 * omitting it — an app you built that quietly fails to appear is much worse
 * than one that appears and tells you what is wrong.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { detectAppType } from './infer.js'
import { resolveManifest } from './manifest.js'

async function readJson(file) {
  try {
    return { value: JSON.parse(await fs.readFile(file, 'utf8')) }
  } catch (err) {
    return { error: `${path.basename(file)} is not valid JSON: ${err.message}` }
  }
}

export async function readApp(dir) {
  const folderName = path.basename(dir)

  let files
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    return {
      id: folderName.toLowerCase(),
      name: folderName,
      dir,
      type: null,
      error: `Cannot read folder: ${err.message}`,
    }
  }

  let pkg = null
  let pkgError
  if (files.includes('package.json')) {
    const res = await readJson(path.join(dir, 'package.json'))
    pkg = res.value ?? null
    pkgError = res.error
  }

  let manifest = {}
  let manifestError
  if (files.includes('reef.json')) {
    const res = await readJson(path.join(dir, 'reef.json'))
    manifest = res.value ?? {}
    manifestError = res.error
  }

  const inferred = detectAppType({ files, pkg })
  const record = resolveManifest({ folderName, inferred, manifest })

  return {
    ...record,
    dir,
    root: path.resolve(dir, record.root ?? '.'),
    error: pkgError ?? manifestError ?? (record.type ? undefined : inferred.reason),
  }
}

// Never worth copying into an adopted app: build artefacts reinstall, VCS
// history belongs to the original, and .DS_Store belongs to no one.
const ADOPT_SKIP = new Set(['node_modules', '.git', '.DS_Store'])

/**
 * Copy a bundled sample into the generated root so the edit chat may own it.
 *
 * Adoption is what lets a shipped sample be editable without weakening the
 * provenance rule: `generated` still derives purely from where the folder
 * lives, so the sample earns the flag by genuinely moving under reef's roof.
 * It is a copy, never a move — deleting the adopted folder resurfaces the
 * pristine bundled original in the next scan (later-wins merge).
 */
export async function adoptApp({ srcDir, destRoot, id }) {
  const dir = path.join(destRoot, id)

  // The generated root owns this name already — a real user's app, possibly
  // full of their data. Refuse rather than merge or overwrite.
  try {
    await fs.access(dir)
    return { ok: false, error: `${dir} already exists` }
  } catch {
    // good: nothing to clobber
  }

  try {
    await fs.mkdir(destRoot, { recursive: true })
    await fs.cp(srcDir, dir, {
      recursive: true,
      filter: (source) => !ADOPT_SKIP.has(path.basename(source)),
    })
  } catch (err) {
    // A half-written copy would show up as a broken app forever; a failed
    // adoption should leave no trace at all.
    await fs.rm(dir, { recursive: true, force: true })
    return { ok: false, error: `Could not copy the app: ${err.message}` }
  }

  return { ok: true, dir }
}

/**
 * `requireManifest` narrows a scan to folders carrying a `reef.json`.
 *
 * Curated directories — the bundled `apps/`, and `userData/apps/` — hold
 * nothing but apps, so inference alone is right there. A folder the user
 * points us at is different: `~/Code` is mostly libraries, forks and scratch
 * repos, and inferring over it would put sixty icons on the desktop and make
 * every one with a `dev` script spawnable. So discovery there is opt-in, and
 * `reef.json` is the marker. Its contents stay optional — an empty `{}`
 * says "I am an app" and inference fills in the rest.
 */
export async function scanApps(appsDir, { requireManifest = false } = {}) {
  let entries
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))

  const eligible = requireManifest
    ? (
        await Promise.all(
          folders.map(async (e) => {
            try {
              await fs.access(path.join(appsDir, e.name, 'reef.json'))
              return e
            } catch {
              return null
            }
          }),
        )
      ).filter(Boolean)
    : folders

  const apps = await Promise.all(eligible.map((e) => readApp(path.join(appsDir, e.name))))

  return apps.sort((a, b) => a.id.localeCompare(b.id))
}
