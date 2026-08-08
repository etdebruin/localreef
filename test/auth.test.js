import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCookies, authDecision, AUTH_COOKIE, AUTH_PARAM } from '../src/gateway/auth.js'

const TOKEN = 'tok_abc123'

function decide({ pathname = '/', query = '', cookie = '', header } = {}) {
  const url = new URL(`http://notes.colony.localhost${pathname}${query}`)
  return authDecision({
    pathname: url.pathname,
    searchParams: url.searchParams,
    cookies: parseCookies(cookie),
    headerToken: header,
    token: TOKEN,
  })
}

test('parseCookies', async (t) => {
  await t.test('parses a normal header', () => {
    assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  })

  await t.test('tolerates odd spacing', () => {
    assert.deepEqual(parseCookies('a=1;b=2;   c=3'), { a: '1', b: '2', c: '3' })
  })

  await t.test('keeps values containing =', () => {
    assert.deepEqual(parseCookies('t=abc=='), { t: 'abc==' })
  })

  await t.test('handles empty and missing input', () => {
    assert.deepEqual(parseCookies(''), {})
    assert.deepEqual(parseCookies(undefined), {})
  })
})

test('authDecision', async (t) => {
  await t.test('allows a request carrying the right cookie', () => {
    const got = decide({ cookie: `${AUTH_COOKIE}=${TOKEN}` })
    assert.equal(got.action, 'allow')
  })

  await t.test('denies a request with no credentials at all', () => {
    assert.equal(decide().action, 'deny')
  })

  await t.test('denies a wrong cookie', () => {
    assert.equal(decide({ cookie: `${AUTH_COOKIE}=nope` }).action, 'deny')
  })

  await t.test('authorizes on the token query param and redirects to a clean URL', () => {
    const got = decide({ pathname: '/', query: `?${AUTH_PARAM}=${TOKEN}` })
    assert.equal(got.action, 'authorize')
    assert.equal(got.redirectTo, '/')
  })

  await t.test('strips only the auth param, preserving the rest of the query', () => {
    const got = decide({ pathname: '/x', query: `?a=1&${AUTH_PARAM}=${TOKEN}&b=2` })
    assert.equal(got.action, 'authorize')
    assert.equal(got.redirectTo, '/x?a=1&b=2')
  })

  await t.test('denies a wrong token in the query param', () => {
    assert.equal(decide({ query: `?${AUTH_PARAM}=nope` }).action, 'deny')
  })

  // Cookies cannot be relied on: an app iframe is a cross-site context, so a
  // SameSite=Lax cookie is set but never sent back. The header is what
  // actually authenticates a framed app.
  await t.test('allows a request carrying the token header', () => {
    assert.equal(decide({ header: TOKEN }).action, 'allow')
  })

  await t.test('denies a wrong token header', () => {
    assert.equal(decide({ header: 'nope' }).action, 'deny')
  })

  await t.test('the header works without any cookie present', () => {
    assert.equal(decide({ header: TOKEN, cookie: '' }).action, 'allow')
  })

  await t.test('lets the health probe through unauthenticated', () => {
    assert.equal(decide({ pathname: '/__colony/health' }).action, 'allow')
  })

  await t.test('does not exempt other reserved paths', () => {
    assert.equal(decide({ pathname: '/__colony/sdk.js' }).action, 'deny')
  })
})
