import test from 'node:test'
import assert from 'node:assert/strict'

import { parseHostname } from '../src/core/routing.js'

test('parseHostname', async (t) => {
  await t.test('extracts the app id', () => {
    assert.equal(parseHostname('notes.desktop.localhost:7777'), 'notes')
  })

  await t.test('works without a port', () => {
    assert.equal(parseHostname('notes.desktop.localhost'), 'notes')
  })

  await t.test('allows hyphens in the app id', () => {
    assert.equal(parseHostname('feed-reader.desktop.localhost:7777'), 'feed-reader')
  })

  await t.test('lowercases the app id', () => {
    assert.equal(parseHostname('Notes.Desktop.Localhost:7777'), 'notes')
  })

  await t.test('rejects the bare gateway host', () => {
    assert.equal(parseHostname('desktop.localhost:7777'), null)
  })

  await t.test('rejects a foreign host', () => {
    assert.equal(parseHostname('evil.com'), null)
  })

  await t.test('rejects a host that merely ends in the suffix', () => {
    assert.equal(parseHostname('notdesktop.localhost'), null)
  })

  await t.test('rejects nested subdomains', () => {
    assert.equal(parseHostname('a.b.desktop.localhost'), null)
  })

  await t.test('rejects an app id with a path separator', () => {
    assert.equal(parseHostname('../etc.desktop.localhost'), null)
  })

  await t.test('handles missing input', () => {
    assert.equal(parseHostname(undefined), null)
    assert.equal(parseHostname(''), null)
  })
})
