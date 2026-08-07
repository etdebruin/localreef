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
  if (files.includes('desktop.json')) {
    const res = await readJson(path.join(dir, 'desktop.json'))
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

export async function scanApps(appsDir) {
  let entries
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  const apps = await Promise.all(folders.map((e) => readApp(path.join(appsDir, e.name))))

  return apps.sort((a, b) => a.id.localeCompare(b.id))
}
