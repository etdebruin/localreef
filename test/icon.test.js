import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { isImageIcon, initialsFor, hueFor, readIconImage } from '../src/core/icon.js'

test('isImageIcon', async (t) => {
  await t.test('recognises image files the manifest may point at', () => {
    for (const icon of ['icon.png', 'art/logo.svg', './icon.webp', 'a.JPEG', 'x.ico']) {
      assert.equal(isImageIcon(icon), true, icon)
    }
  })

  await t.test('an emoji is not an image path', () => {
    for (const icon of ['📝', '🕓', '🎚️', '👨‍👩‍👧‍👦']) {
      assert.equal(isImageIcon(icon), false, icon)
    }
  })

  await t.test('a bare letter or word is not an image path', () => {
    assert.equal(isImageIcon('N'), false)
    assert.equal(isImageIcon('notes'), false)
  })

  await t.test('nothing at all is not an image path', () => {
    assert.equal(isImageIcon(null), false)
    assert.equal(isImageIcon(undefined), false)
    assert.equal(isImageIcon(''), false)
  })

  await t.test('an unknown extension is not treated as an image', () => {
    // Rendering an arbitrary file as an icon would be a way to smuggle
    // something unexpected into an <img> tag.
    assert.equal(isImageIcon('icon.exe'), false)
    assert.equal(isImageIcon('notes.html'), false)
  })
})

test('initialsFor', async (t) => {
  await t.test('takes the first letter of a one-word name', () => {
    assert.equal(initialsFor('Notes'), 'N')
    assert.equal(initialsFor('clock'), 'C')
  })

  await t.test('takes two letters from a multi-word name', () => {
    assert.equal(initialsFor('Feed Reader'), 'FR')
    assert.equal(initialsFor('my cool app'), 'MC')
  })

  await t.test('ignores separators that are not letters', () => {
    assert.equal(initialsFor('feed-reader'), 'FR')
    assert.equal(initialsFor('feed_reader'), 'FR')
  })

  await t.test('handles a digit-led name', () => {
    assert.equal(initialsFor('7ctos'), '7')
  })

  await t.test('falls back rather than rendering nothing', () => {
    assert.equal(initialsFor(''), '?')
    assert.equal(initialsFor(null), '?')
    assert.equal(initialsFor('   '), '?')
  })
})

test('hueFor', async (t) => {
  await t.test('is stable for the same id', () => {
    assert.equal(hueFor('notes'), hueFor('notes'))
  })

  await t.test('stays inside the colour wheel', () => {
    for (const id of ['notes', 'clock', 'chart', 'a', '', 'a-very-long-app-identifier']) {
      const hue = hueFor(id)
      assert.ok(Number.isInteger(hue), `${id} -> ${hue}`)
      assert.ok(hue >= 0 && hue < 360, `${id} -> ${hue}`)
    }
  })

  await t.test('separates similar ids', () => {
    // Adjacent names are the common case on a real desktop; they must not all
    // land on the same hue or the generated tiles stop distinguishing anything.
    const hues = ['app1', 'app2', 'app3', 'app4'].map(hueFor)
    assert.equal(new Set(hues).size, 4)
  })

  await t.test('spreads a realistic set across the wheel', () => {
    const ids = ['notes', 'clock', 'chart', 'feed', 'underscore', 'timer', 'budget', 'inbox']
    const hues = ids.map(hueFor)

    // Every quadrant of the wheel should be reachable; a hash that clusters
    // would make a dock of apps read as one colour.
    const quadrants = new Set(hues.map((h) => Math.floor(h / 90)))
    assert.ok(quadrants.size >= 3, `hues=${hues} quadrants=${[...quadrants]}`)
  })
})

test('readIconImage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-icon-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const app = path.join(root, 'notes')
  await fs.mkdir(app, { recursive: true })
  await fs.writeFile(path.join(app, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.writeFile(path.join(root, 'outside.png'), Buffer.from([0x89, 0x50]))

  await t.test('reads an icon in the app folder as a data URI', async () => {
    const uri = await readIconImage(app, 'icon.png')
    assert.match(uri, /^data:image\/png;base64,/)
    assert.equal(uri, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
  })

  await t.test('returns null for an emoji', async () => {
    assert.equal(await readIconImage(app, '📝'), null)
  })

  await t.test('returns null when the file is not there', async () => {
    assert.equal(await readIconImage(app, 'missing.png'), null)
  })

  await t.test('refuses to escape the app folder', async () => {
    // The manifest is written by the user or the model, so this path is
    // untrusted input — same posture as the gateway's request paths.
    assert.equal(await readIconImage(app, '../outside.png'), null)
    assert.equal(await readIconImage(app, '/etc/hosts'), null)
  })

  await t.test('refuses an icon too large to sit in an IPC payload', async () => {
    const big = path.join(app, 'big.png')
    await fs.writeFile(big, Buffer.alloc(600 * 1024))
    assert.equal(await readIconImage(app, 'big.png'), null)
  })
})
