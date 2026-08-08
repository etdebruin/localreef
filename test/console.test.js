import test from 'node:test'
import assert from 'node:assert/strict'

import { createConsoleCapture } from '../src/core/console.js'

test('createConsoleCapture', async (t) => {
  await t.test('attributes an error to its app by frame origin', () => {
    const capture = createConsoleCapture()

    capture.record({
      level: 'error',
      message: "Uncaught TypeError: Cannot read properties of null (reading 'value')",
      frameUrl: 'http://first-chair.reef.localhost:4820/',
      sourceUrl: 'http://first-chair.reef.localhost:4820/index.html',
      line: 212,
    })

    const recent = capture.recent('first-chair')
    assert.equal(recent.length, 1)
    assert.match(recent[0], /Uncaught TypeError/)
    assert.match(recent[0], /index\.html:212/)
  })

  await t.test('keeps apps separate', () => {
    const capture = createConsoleCapture()
    capture.record({ level: 'error', message: 'a', frameUrl: 'http://notes.reef.localhost:1/' })
    capture.record({ level: 'error', message: 'b', frameUrl: 'http://clock.reef.localhost:1/' })

    assert.deepEqual(capture.recent('notes'), ['a'])
    assert.deepEqual(capture.recent('clock'), ['b'])
  })

  // A static app's document is served at "/", so that is what Chromium names
  // as the source of an inline-script error. The model needs the file it can
  // actually open — and "/" is index.html by the gateway's own convention.
  await t.test('names the root document index.html', () => {
    const capture = createConsoleCapture()
    capture.record({
      level: 'error',
      message: 'Uncaught TypeError: x is null',
      frameUrl: 'http://notes.reef.localhost:4820/',
      sourceUrl: 'http://notes.reef.localhost:4820/',
      line: 5,
    })

    assert.deepEqual(capture.recent('notes'), ['Uncaught TypeError: x is null (index.html:5)'])
  })

  // The legacy console-message signature has no frame — the script URL is the
  // best remaining evidence of which app spoke.
  await t.test('falls back to the source URL when the frame is unknown', () => {
    const capture = createConsoleCapture()
    capture.record({
      level: 'error',
      message: 'boom',
      sourceUrl: 'http://notes.reef.localhost:4820/app.js',
      line: 3,
    })

    assert.deepEqual(capture.recent('notes'), ['boom (app.js:3)'])
  })

  await t.test('ignores everything that is not an app frame', () => {
    const capture = createConsoleCapture()

    // The shell's own renderer, devtools, a stray localhost page — none of
    // these belong in any app's buffer.
    capture.record({ level: 'error', message: 'x', frameUrl: 'file:///renderer/index.html' })
    capture.record({ level: 'error', message: 'x', frameUrl: 'http://localhost:5173/' })
    capture.record({ level: 'error', message: 'x' })

    assert.deepEqual(capture.recent('renderer'), [])
    assert.deepEqual(capture.recent('localhost'), [])
  })

  await t.test('records errors only', () => {
    const capture = createConsoleCapture()
    const at = (level) =>
      capture.record({ level, message: 'm', frameUrl: 'http://notes.reef.localhost:1/' })

    at('log')
    at('info')
    at('warning')
    at('debug')
    assert.deepEqual(capture.recent('notes'), [])

    at('error')
    assert.equal(capture.recent('notes').length, 1)
  })

  // Electron's legacy console-message signature uses numeric levels; 3 is
  // error. Both shapes arrive in the wild depending on Electron version.
  await t.test('accepts the legacy numeric error level', () => {
    const capture = createConsoleCapture()
    capture.record({ level: 3, message: 'm', frameUrl: 'http://notes.reef.localhost:1/' })
    capture.record({ level: 2, message: 'warn', frameUrl: 'http://notes.reef.localhost:1/' })

    assert.deepEqual(capture.recent('notes'), ['m'])
  })

  await t.test('caps the buffer and keeps the newest', () => {
    const capture = createConsoleCapture({ limit: 3 })
    for (let i = 1; i <= 5; i++) {
      capture.record({ level: 'error', message: `e${i}`, frameUrl: 'http://notes.reef.localhost:1/' })
    }

    assert.deepEqual(capture.recent('notes'), ['e3', 'e4', 'e5'])
  })

  // A change on disk invalidates the evidence: errors thrown by the old code
  // must not steer the next fix.
  await t.test('clear forgets one app and leaves the rest', () => {
    const capture = createConsoleCapture()
    capture.record({ level: 'error', message: 'a', frameUrl: 'http://notes.reef.localhost:1/' })
    capture.record({ level: 'error', message: 'b', frameUrl: 'http://clock.reef.localhost:1/' })

    capture.clear('notes')
    assert.deepEqual(capture.recent('notes'), [])
    assert.deepEqual(capture.recent('clock'), ['b'])
  })

  await t.test('deduplicates an error that repeats back to back', () => {
    const capture = createConsoleCapture()
    for (let i = 0; i < 4; i++) {
      capture.record({
        level: 'error',
        message: 'Uncaught TypeError: x is null',
        frameUrl: 'http://notes.reef.localhost:1/',
        sourceUrl: 'http://notes.reef.localhost:1/index.html',
        line: 7,
      })
    }

    // A render loop throwing per frame would otherwise flood the buffer with
    // one fact. Keep it once, marked as repeating.
    const recent = capture.recent('notes')
    assert.equal(recent.length, 1)
    assert.match(recent[0], /×4|4 times/i)
  })
})
