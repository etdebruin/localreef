import test from 'node:test'
import assert from 'node:assert/strict'

import { MODELS, ROUTE_TOOL, createRouter, parseRoute, routePrompt } from '../src/main/agent.js'

const REGISTRY = [
  { id: 'notes', name: 'Notes' },
  { id: 'clock', name: 'Clock' },
  { id: 'mail-dash', name: 'Mail Dashboard' },
]

test('routePrompt', async (t) => {
  await t.test('carries the prompt and every installed app', () => {
    const text = routePrompt('check my emails', REGISTRY)
    assert.match(text, /check my emails/)
    for (const app of REGISTRY) {
      assert.match(text, new RegExp(app.id))
      assert.match(text, new RegExp(app.name))
    }
  })

  await t.test('says so when nothing is installed', () => {
    const text = routePrompt('a timer', [])
    assert.match(text, /none|no apps/i)
  })
})

test('parseRoute', async (t) => {
  await t.test('open with a known app id passes through', () => {
    assert.deepEqual(parseRoute({ intent: 'open', app: 'clock' }, REGISTRY), {
      intent: 'open',
      app: 'clock',
    })
  })

  // The model names apps; an id it invented must not open (or build) anything.
  await t.test('open with an unknown id becomes a reply, not a build', () => {
    const routed = parseRoute({ intent: 'open', app: 'mailbox' }, REGISTRY)
    assert.equal(routed.intent, 'other')
    assert.ok(routed.reply.length > 0)
  })

  await t.test('other with a reply passes through trimmed', () => {
    const routed = parseRoute({ intent: 'other', reply: '  Reef cannot read mail.  ' }, REGISTRY)
    assert.deepEqual(routed, { intent: 'other', reply: 'Reef cannot read mail.' })
  })

  await t.test('other without a reply still answers something', () => {
    const routed = parseRoute({ intent: 'other' }, REGISTRY)
    assert.equal(routed.intent, 'other')
    assert.ok(routed.reply.length > 0)
  })

  await t.test('build passes through', () => {
    assert.deepEqual(parseRoute({ intent: 'build' }, REGISTRY), { intent: 'build' })
  })

  // Anything unrecognisable falls back to what ⌘K always did: build. The
  // router must only ever improve on the old behaviour, never brick it.
  await t.test('garbage falls back to build', () => {
    for (const bad of [null, undefined, {}, { intent: 'dance' }, 'open', 42]) {
      assert.deepEqual(parseRoute(bad, REGISTRY), { intent: 'build' }, `input: ${JSON.stringify(bad)}`)
    }
  })
})

test('createRouter', async (t) => {
  await t.test('routes through the runner and parses the decision', async () => {
    let seen
    const router = createRouter({
      runRoute: async (request) => {
        seen = request
        return { intent: 'open', app: 'notes' }
      },
    })

    const routed = await router.route({ prompt: 'open my notes', apps: REGISTRY })
    assert.deepEqual(routed, { intent: 'open', app: 'notes' })
    assert.match(seen.prompt, /open my notes/)
    assert.match(seen.prompt, /mail-dash/)
  })

  await t.test('a runner failure falls back to build', async () => {
    const router = createRouter({
      runRoute: async () => {
        throw new Error('socket died')
      },
    })
    assert.deepEqual(await router.route({ prompt: 'a timer', apps: REGISTRY }), { intent: 'build' })
  })

  // The router is a latency tax on every ⌘K submit; a hung classifier must
  // not hold the palette hostage.
  await t.test('a slow runner falls back to build', async () => {
    const router = createRouter({
      runRoute: () => new Promise(() => {}),
      timeoutMs: 25,
    })
    assert.deepEqual(await router.route({ prompt: 'a timer', apps: REGISTRY }), { intent: 'build' })
  })
})

test('route model and tool shape', async (t) => {
  await t.test('the route tier is pinned to the fast model', () => {
    assert.equal(MODELS.route, 'claude-haiku-4-5')
  })

  await t.test('the tool constrains intent to the closed set', () => {
    assert.deepEqual(ROUTE_TOOL.input_schema.properties.intent.enum, ['open', 'build', 'other'])
    assert.deepEqual(ROUTE_TOOL.input_schema.required, ['intent'])
  })
})
