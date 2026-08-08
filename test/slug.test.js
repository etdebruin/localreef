import test from 'node:test'
import assert from 'node:assert/strict'

import { slugify, uniqueId } from '../src/core/slug.js'
import { parseHostname } from '../src/core/routing.js'

test('slugify', async (t) => {
  await t.test('turns a description into a short id', () => {
    assert.equal(slugify('a tool to track my running mileage'), 'track-running-mileage')
  })

  await t.test('drops filler words', () => {
    assert.equal(slugify('an app for managing the reading list'), 'managing-reading-list')
  })

  await t.test('lowercases and strips punctuation', () => {
    assert.equal(slugify('Budget Tracker!! (v2)'), 'budget-tracker-v2')
  })

  await t.test('caps the number of words', () => {
    assert.equal(slugify('one two three four five six seven'), 'one-two-three')
  })

  await t.test('strips characters that are not id-safe', () => {
    assert.equal(slugify('café ☕ notes'), 'caf-notes')
  })

  await t.test('never starts with a hyphen or digit-only garbage', () => {
    assert.match(slugify('---weird---'), /^[a-z0-9]/)
  })

  await t.test('falls back for input with nothing usable', () => {
    assert.equal(slugify('☕☕☕'), 'app')
    assert.equal(slugify(''), 'app')
  })

  // The id becomes a hostname label, so it has to survive the router.
  await t.test('always produces something the gateway will route', () => {
    const prompts = [
      'a tool to track my running mileage',
      'Budget Tracker!! (v2)',
      '☕☕☕',
      '../../etc/passwd',
      'a'.repeat(200),
    ]
    for (const prompt of prompts) {
      const id = slugify(prompt)
      assert.equal(parseHostname(`${id}.reef.localhost:1234`), id, `failed for: ${prompt}`)
    }
  })
})

test('uniqueId', async (t) => {
  await t.test('passes through when free', () => {
    assert.equal(uniqueId('notes', []), 'notes')
  })

  await t.test('suffixes when taken', () => {
    assert.equal(uniqueId('notes', ['notes']), 'notes-2')
    assert.equal(uniqueId('notes', ['notes', 'notes-2']), 'notes-3')
  })

  await t.test('accepts a Set as well as an array', () => {
    assert.equal(uniqueId('notes', new Set(['notes'])), 'notes-2')
  })

  await t.test('the suffixed id is still routable', () => {
    const id = uniqueId('notes', ['notes'])
    assert.equal(parseHostname(`${id}.reef.localhost:1234`), id)
  })
})
