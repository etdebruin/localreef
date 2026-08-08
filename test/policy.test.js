import test from 'node:test'
import assert from 'node:assert/strict'

import { allowsMedia, framePolicy, withAiGrant } from '../src/core/policy.js'

test('framePolicy', async (t) => {
  await t.test('declares nothing when the manifest declares nothing', () => {
    assert.equal(framePolicy([]), '')
    assert.equal(framePolicy(), '')
  })

  await t.test('maps mic to the Permissions Policy feature name', () => {
    assert.equal(framePolicy(['mic']), 'microphone')
  })

  await t.test('maps camera', () => {
    assert.equal(framePolicy(['camera']), 'camera')
  })

  await t.test('lists both, separated the way the attribute expects', () => {
    assert.equal(framePolicy(['camera', 'mic']), 'microphone; camera')
  })

  await t.test('ignores permissions that are not frame features', () => {
    assert.equal(framePolicy(['storage', 'ai', 'net:api.github.com']), '')
    assert.equal(framePolicy(['storage', 'mic']), 'microphone')
  })

  await t.test('never emits a feature an app did not ask for', () => {
    // A wildcard is meaningful for `net:`, but must not leak into device access.
    assert.equal(framePolicy(['net:*']), '')
    assert.equal(framePolicy(['*']), '')
  })
})

test('withAiGrant', async (t) => {
  await t.test('injects the key for an app that declared ai', () => {
    const env = withAiGrant({ PATH: '/usr/bin' }, ['ai'], 'sk-configured')
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-configured')
    assert.equal(env.PATH, '/usr/bin')
  })

  await t.test('strips an inherited key from an app that declared nothing', () => {
    // Launched from a terminal, process.env carries the user's key. The
    // manifest posture is "absent means denied" — same as mic and camera.
    const env = withAiGrant({ ANTHROPIC_API_KEY: 'sk-inherited' }, [], 'sk-configured')
    assert.equal('ANTHROPIC_API_KEY' in env, false)
  })

  await t.test('strips the inherited key even when no key is configured', () => {
    const env = withAiGrant({ ANTHROPIC_API_KEY: 'sk-inherited' }, ['storage'], null)
    assert.equal('ANTHROPIC_API_KEY' in env, false)
  })

  await t.test('the configured key replaces an inherited one', () => {
    // Settings beat the environment, same rule as resolveApiKey — so a key
    // pasted into Settings takes effect without relaunching from a terminal.
    const env = withAiGrant({ ANTHROPIC_API_KEY: 'sk-inherited' }, ['ai'], 'sk-configured')
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-configured')
  })

  await t.test('declaring ai with no key anywhere grants nothing', () => {
    const env = withAiGrant({}, ['ai'], null)
    assert.equal('ANTHROPIC_API_KEY' in env, false)
  })

  await t.test('does not mutate the environment it was given', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-inherited' }
    withAiGrant(base, [], null)
    assert.equal(base.ANTHROPIC_API_KEY, 'sk-inherited')
  })

  await t.test('tolerates a missing permissions list', () => {
    const env = withAiGrant({ ANTHROPIC_API_KEY: 'sk-inherited' }, undefined, 'sk-configured')
    assert.equal('ANTHROPIC_API_KEY' in env, false)
  })
})

test('allowsMedia', async (t) => {
  await t.test('denies an app that declared no media permission', () => {
    assert.equal(allowsMedia([], ['audio']), false)
    assert.equal(allowsMedia(['storage'], ['audio']), false)
  })

  await t.test('grants audio only to an app that declared mic', () => {
    assert.equal(allowsMedia(['mic'], ['audio']), true)
    assert.equal(allowsMedia(['camera'], ['audio']), false)
  })

  await t.test('grants video only to an app that declared camera', () => {
    assert.equal(allowsMedia(['camera'], ['video']), true)
    assert.equal(allowsMedia(['mic'], ['video']), false)
  })

  await t.test('a combined request needs every part declared', () => {
    assert.equal(allowsMedia(['mic'], ['audio', 'video']), false)
    assert.equal(allowsMedia(['mic', 'camera'], ['audio', 'video']), true)
  })

  await t.test('denies a request that names no media type at all', () => {
    // Chromium omits mediaTypes for screen capture; nothing here grants that.
    assert.equal(allowsMedia(['mic', 'camera'], []), false)
    assert.equal(allowsMedia(['mic', 'camera']), false)
  })
})
