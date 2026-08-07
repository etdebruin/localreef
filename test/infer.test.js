import test from 'node:test'
import assert from 'node:assert/strict'

import { detectAppType, detectPackageManager } from '../src/core/infer.js'

test('detectPackageManager', async (t) => {
  await t.test('pnpm lockfile wins', () => {
    assert.equal(detectPackageManager(['pnpm-lock.yaml', 'package.json']), 'pnpm')
  })

  await t.test('yarn lockfile', () => {
    assert.equal(detectPackageManager(['yarn.lock']), 'yarn')
  })

  await t.test('bun lockfile', () => {
    assert.equal(detectPackageManager(['bun.lockb']), 'bun')
  })

  await t.test('defaults to npm with no lockfile', () => {
    assert.equal(detectPackageManager(['package.json']), 'npm')
  })

  await t.test('package-lock is explicitly npm', () => {
    assert.equal(detectPackageManager(['package-lock.json']), 'npm')
  })
})

test('detectAppType', async (t) => {
  await t.test('index.html with no package.json is static', () => {
    const got = detectAppType({ files: ['index.html', 'app.js'], pkg: null })
    assert.equal(got.type, 'static')
    assert.equal(got.root, '.')
  })

  await t.test('dev script is a node server', () => {
    const got = detectAppType({
      files: ['package.json', 'vite.config.js'],
      pkg: { scripts: { dev: 'vite' } },
    })
    assert.equal(got.type, 'server')
    assert.equal(got.run, 'npm run dev')
  })

  await t.test('dev script uses the detected package manager', () => {
    const got = detectAppType({
      files: ['package.json', 'pnpm-lock.yaml'],
      pkg: { scripts: { dev: 'vite' } },
    })
    assert.equal(got.run, 'pnpm run dev')
  })

  await t.test('start script is used when there is no dev script', () => {
    const got = detectAppType({
      files: ['package.json'],
      pkg: { scripts: { start: 'node server.js' } },
    })
    assert.equal(got.type, 'server')
    assert.equal(got.run, 'npm start')
  })

  await t.test('dev wins over start', () => {
    const got = detectAppType({
      files: ['package.json'],
      pkg: { scripts: { dev: 'vite', start: 'node server.js' } },
    })
    assert.equal(got.run, 'npm run dev')
  })

  await t.test('index.html plus a scriptless package.json is static', () => {
    const got = detectAppType({
      files: ['index.html', 'package.json'],
      pkg: { dependencies: { lodash: '^4' } },
    })
    assert.equal(got.type, 'static')
    assert.equal(got.root, '.')
  })

  await t.test('static prefers dist/ when present', () => {
    const got = detectAppType({
      files: ['index.html', 'package.json', 'dist'],
      pkg: { name: 'x' },
    })
    assert.equal(got.type, 'static')
    assert.equal(got.root, 'dist')
  })

  await t.test('an empty folder is unrecognised, with a reason', () => {
    const got = detectAppType({ files: ['README.md'], pkg: null })
    assert.equal(got.type, null)
    assert.match(got.reason, /index\.html/)
  })
})
