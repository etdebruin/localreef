import test from 'node:test'
import assert from 'node:assert/strict'

import { greetingFor } from '../src/core/greeting.js'

test('greetingFor', async (t) => {
  await t.test('greets by name in the morning', () => {
    const { title } = greetingFor('Etienne', 8)
    assert.equal(title, 'Good morning, Etienne')
  })

  await t.test('the segments cover the clock', () => {
    // Boundaries chosen to pin the edges, not just the middles.
    assert.match(greetingFor('A', 5).title, /^Good morning/)
    assert.match(greetingFor('A', 11).title, /^Good morning/)
    assert.match(greetingFor('A', 12).title, /^Good afternoon/)
    assert.match(greetingFor('A', 16).title, /^Good afternoon/)
    assert.match(greetingFor('A', 17).title, /^Good evening/)
    assert.match(greetingFor('A', 21).title, /^Good evening/)
    assert.match(greetingFor('A', 22).title, /^Up late/)
    assert.match(greetingFor('A', 2).title, /^Up late/)
    assert.match(greetingFor('A', 4).title, /^Up late/)
  })

  await t.test('late night keeps the name', () => {
    assert.equal(greetingFor('Etienne', 23).title, 'Up late, Etienne?')
  })

  await t.test('every greeting carries a subline', () => {
    for (const hour of [8, 14, 19, 23]) {
      const { sub } = greetingFor('Etienne', hour)
      assert.ok(typeof sub === 'string' && sub.length > 0, `no subline at hour ${hour}`)
    }
  })

  await t.test('whitespace around the name is trimmed', () => {
    assert.equal(greetingFor('  Etienne  ', 8).title, 'Good morning, Etienne')
  })

  await t.test('survives a missing name rather than greeting "null"', () => {
    assert.equal(greetingFor(null, 8).title, 'Good morning')
    assert.equal(greetingFor('   ', 23).title, 'Up late?')
  })

  await t.test('an out-of-range hour still greets', () => {
    // Defensive: a bad clock must never crash the desktop's first paint.
    assert.ok(greetingFor('Etienne', NaN).title.length > 0)
    assert.ok(greetingFor('Etienne', 99).title.length > 0)
  })
})
