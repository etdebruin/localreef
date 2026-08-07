import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFixer } from '../src/main/agent.js'

async function brokenApp(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-fix-'))
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body)
  }
  return dir
}

const toolMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]))

test('createFixer', async (t) => {
  await t.test('edits the existing app in place and reports what changed', async () => {
    const dir = await brokenApp({
      'index.html': '<h1>broken</h1>',
      'desktop.json': '{"name":"Thing"}',
    })

    const runAgent = async ({ tools }) => {
      const map = toolMap(tools)
      await map.write_file.run({ path: 'index.html', content: '<h1>fixed</h1>' })
      return { stop_reason: 'end_turn' }
    }

    const result = await createFixer({ runAgent }).fix({ id: 'thing', dir, error: 'boom' })

    assert.equal(result.ok, true)
    assert.deepEqual(result.files, ['index.html'])
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<h1>fixed</h1>')
    // Untouched files stay untouched.
    assert.equal(await fs.readFile(path.join(dir, 'desktop.json'), 'utf8'), '{"name":"Thing"}')
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Unlike generation, a failed fix must never remove the folder — for a
  // linked app that folder is the user's actual project.
  await t.test('never deletes the app folder when the agent writes nothing', async () => {
    const dir = await brokenApp({ 'index.html': '<h1>broken</h1>' })
    const runAgent = async () => ({ stop_reason: 'end_turn' })

    const result = await createFixer({ runAgent }).fix({ id: 'thing', dir, error: 'boom' })

    assert.equal(result.ok, false)
    assert.match(result.error, /no changes/i)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('never deletes the app folder on a refusal', async () => {
    const dir = await brokenApp({ 'index.html': 'x' })
    const runAgent = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' } })

    const result = await createFixer({ runAgent }).fix({ id: 'thing', dir, error: 'boom' })

    assert.equal(result.ok, false)
    assert.match(result.error, /declined|refus/i)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('never deletes the app folder when the agent throws', async () => {
    const dir = await brokenApp({ 'index.html': 'x' })
    const runAgent = async () => {
      throw new Error('network died')
    }

    const result = await createFixer({ runAgent }).fix({ id: 'thing', dir, error: 'boom' })

    assert.equal(result.ok, false)
    assert.match(result.error, /network died/)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('gives the model the failure and the current file list', async () => {
    const dir = await brokenApp({ 'index.html': 'x', 'server.js': 'y' })
    let seen = null

    const runAgent = async (args) => {
      seen = args
      await toolMap(args.tools).write_file.run({ path: 'index.html', content: 'ok' })
      return { stop_reason: 'end_turn' }
    }

    await createFixer({ runAgent }).fix({
      id: 'thing',
      dir,
      error: 'Exited with code 1',
      logs: ['ReferenceError: foo is not defined', '    at server.js:3'],
    })

    assert.match(seen.prompt, /Exited with code 1/)
    assert.match(seen.prompt, /ReferenceError: foo is not defined/)
    assert.match(seen.prompt, /index\.html/)
    assert.match(seen.prompt, /server\.js/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('reports progress per file written', async () => {
    const dir = await brokenApp({ 'index.html': 'x' })
    const events = []

    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'fixed' })
      return { stop_reason: 'end_turn' }
    }

    await createFixer({ runAgent }).fix({
      id: 'thing',
      dir,
      error: 'boom',
      onProgress: (e) => events.push(e),
    })

    const phases = events.map((e) => e.phase)
    assert.ok(phases.includes('reading'), phases.join(','))
    assert.ok(phases.includes('writing'), phases.join(','))
    assert.ok(phases.includes('done'), phases.join(','))
    assert.ok(events.some((e) => e.file === 'index.html'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('refuses to touch anything outside the app folder', async () => {
    const dir = await brokenApp({ 'index.html': 'x' })

    const runAgent = async ({ tools }) => {
      const out = await toolMap(tools).write_file.run({
        path: '../escaped.txt',
        content: 'nope',
      })
      assert.match(out, /outside|refus/i)
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'ok' })
      return { stop_reason: 'end_turn' }
    }

    const result = await createFixer({ runAgent }).fix({ id: 'thing', dir, error: 'boom' })

    assert.equal(result.ok, true)
    assert.equal((await fs.readdir(path.dirname(dir))).includes('escaped.txt'), false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
