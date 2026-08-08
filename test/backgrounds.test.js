import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BACKGROUNDS,
  DEFAULT_BACKGROUND_ID,
  resolveBackground,
  backgroundFile,
} from '../src/core/backgrounds.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('BACKGROUNDS', async (t) => {
  await t.test('every id is unique', () => {
    const ids = BACKGROUNDS.map((b) => b.id)
    assert.equal(new Set(ids).size, ids.length, ids.join(','))
  })

  await t.test('every entry has a name and a known kind', () => {
    for (const bg of BACKGROUNDS) {
      assert.ok(bg.name, `${bg.id} needs a name`)
      assert.ok(['image', 'gradient'].includes(bg.kind), `${bg.id} kind=${bg.kind}`)
    }
  })

  await t.test('image entries name a file, gradient entries carry css', () => {
    for (const bg of BACKGROUNDS) {
      if (bg.kind === 'image') assert.ok(bg.file, `${bg.id} needs a file`)
      else assert.ok(bg.css, `${bg.id} needs css`)
    }
  })

  await t.test('every image file actually exists on disk', async () => {
    // A catalogue entry pointing at a missing file renders as a blank canvas
    // with no error anywhere — exactly the kind of silent failure worth a test.
    for (const bg of BACKGROUNDS.filter((b) => b.kind === 'image')) {
      const file = path.join(projectRoot, 'assets/backgrounds', bg.file)
      await fs.access(file)
    }
  })

  await t.test('every entry carries its own scrim', () => {
    // Scrim values are tuned per image: one picture is bright top-centre,
    // another is bright at the edges. A single global scrim cannot serve both.
    for (const bg of BACKGROUNDS) {
      assert.equal(typeof bg.scrim.top, 'number', bg.id)
      assert.equal(typeof bg.scrim.bottom, 'number', bg.id)
      assert.equal(typeof bg.scrim.vignette, 'number', bg.id)
      for (const [key, value] of Object.entries(bg.scrim)) {
        assert.ok(value >= 0 && value <= 1, `${bg.id}.${key}=${value}`)
      }
    }
  })

  await t.test('the default id is one of them', () => {
    assert.ok(BACKGROUNDS.some((b) => b.id === DEFAULT_BACKGROUND_ID))
  })
})

test('resolveBackground', async (t) => {
  await t.test('finds one by id', () => {
    assert.equal(resolveBackground('exotic-reef').id, 'exotic-reef')
  })

  await t.test('falls back to the default for an unknown id', () => {
    // Settings survive a release that removes a background; a stale id must
    // not leave the canvas blank.
    assert.equal(resolveBackground('deleted-in-a-later-version').id, DEFAULT_BACKGROUND_ID)
  })

  await t.test('falls back for nothing at all', () => {
    assert.equal(resolveBackground(null).id, DEFAULT_BACKGROUND_ID)
    assert.equal(resolveBackground(undefined).id, DEFAULT_BACKGROUND_ID)
  })
})

test('backgroundFile', async (t) => {
  await t.test('returns a path for an image background', () => {
    assert.match(backgroundFile(resolveBackground('tranquil-reef')), /tranquil-reef\.webp$/)
  })

  await t.test('returns null for a gradient background', () => {
    const gradient = BACKGROUNDS.find((b) => b.kind === 'gradient')
    assert.equal(backgroundFile(gradient), null)
  })
})
