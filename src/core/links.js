/**
 * Linked apps.
 *
 * A project you already have — anywhere on disk — can appear on the desktop
 * without being moved or copied. We store absolute paths and read the folder
 * where it lives, so the app stays yours: editing it in your editor is editing
 * the thing the desktop runs.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const normalise = (dir) => path.resolve(String(dir))

export function createLinkStore(file) {
  async function readRaw() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // Missing or corrupt: an unreadable link list should never stop the
      // desktop from starting.
      return []
    }
  }

  async function write(list) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
  }

  /** Live folders only — entries that have been deleted or moved are pruned. */
  async function list() {
    const raw = await readRaw()
    const alive = []

    for (const entry of raw) {
      const dir = normalise(entry)
      if (alive.includes(dir)) continue
      try {
        if ((await fs.stat(dir)).isDirectory()) alive.push(dir)
      } catch {
        /* folder is gone; drop it */
      }
    }

    if (alive.length !== raw.length) await write(alive)
    return alive
  }

  async function add(dir) {
    const target = normalise(dir)

    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      return { ok: false, error: `No such folder: ${target}` }
    }
    if (!stat.isDirectory()) {
      return { ok: false, error: 'That is a file — link the folder that contains it.' }
    }

    const current = await list()
    if (!current.includes(target)) await write([...current, target])
    return { ok: true, dir: target }
  }

  async function remove(dir) {
    const target = normalise(dir)
    await write((await list()).filter((entry) => entry !== target))
    return { ok: true }
  }

  return { list, add, remove }
}
