import test from 'node:test'
import assert from 'node:assert/strict'

import { sniffPort } from '../src/core/probe.js'

test('sniffPort', async (t) => {
  await t.test('reads the Vite banner', () => {
    assert.equal(sniffPort('  ➜  Local:   http://localhost:5173/'), 5173)
  })

  await t.test('strips ANSI colour codes', () => {
    const line = '  [32m➜[39m  [1mLocal[22m: [36mhttp://localhost:5174/[39m'
    assert.equal(sniffPort(line), 5174)
  })

  await t.test('reads a plain listening line', () => {
    assert.equal(sniffPort('Listening on http://127.0.0.1:3000'), 3000)
  })

  await t.test('reads a bare host:port pair', () => {
    assert.equal(sniffPort('ready - started server on 0.0.0.0:3000'), 3000)
  })

  await t.test('reads an IPv6 loopback URL', () => {
    assert.equal(sniffPort('Server running at http://[::1]:8080/'), 8080)
  })

  await t.test('ignores non-loopback hosts', () => {
    assert.equal(sniffPort('fetching http://example.com:8080/deps'), null)
  })

  await t.test('ignores registry chatter', () => {
    assert.equal(sniffPort('npm WARN deprecated foo@1.0.0'), null)
    assert.equal(sniffPort('GET https://registry.npmjs.org/vite 200'), null)
  })

  await t.test('ignores an out-of-range port', () => {
    assert.equal(sniffPort('http://localhost:99999/'), null)
  })

  await t.test('handles empty input', () => {
    assert.equal(sniffPort(''), null)
    assert.equal(sniffPort(undefined), null)
  })
})
