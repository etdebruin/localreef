import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createEditor } from '../src/main/agent.js'

async function appOnDisk(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-edit-'))
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body)
  }
  return dir
}

const toolMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]))

/** The final-message shape the runner returns: text blocks + stop_reason. */
const said = (text) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
})

test('createEditor', async (t) => {
  await t.test('edits the app in place and returns the reply', async () => {
    const dir = await appOnDisk({
      'index.html': '<h1>timer</h1>',
      'reef.json': '{"name":"Timer"}',
    })

    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: '<h1>TIMER</h1>' })
      return said('Made the heading louder.')
    }

    const result = await createEditor({ runAgent }).edit({
      id: 'timer',
      dir,
      message: 'shout the heading',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.files, ['index.html'])
    assert.equal(result.reply, 'Made the heading louder.')
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<h1>TIMER</h1>')
    assert.equal(await fs.readFile(path.join(dir, 'reef.json'), 'utf8'), '{"name":"Timer"}')
    await fs.rm(dir, { recursive: true, force: true })
  })

  // A turn may be a question — zero writes is a success, unlike the fixer.
  await t.test('answers a question without writing anything', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const runAgent = async () => said('It keeps entries in localStorage under "timer.laps".')

    const result = await createEditor({ runAgent }).edit({
      id: 'timer',
      dir,
      message: 'where does it store laps?',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.files, [])
    assert.match(result.reply, /localStorage/)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('a wordless turn that wrote files still gets a reply', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'y' })
      return { stop_reason: 'end_turn', content: [] }
    }

    const result = await createEditor({ runAgent }).edit({ id: 'a', dir, message: 'tweak' })

    assert.equal(result.ok, true)
    assert.equal(typeof result.reply, 'string')
    assert.ok(result.reply.length > 0, 'reply must never be empty — it fills a chat bubble')
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('gives the agent the message, a fresh file listing, and the history', async () => {
    const dir = await appOnDisk({ 'index.html': 'x', 'app.js': 'y' })
    const history = [
      { role: 'user', content: 'make it blue' },
      { role: 'assistant', content: 'Done.' },
    ]

    let seen
    const runAgent = async (args) => {
      seen = args
      return said('ok')
    }

    await createEditor({ runAgent }).edit({
      id: 'thing',
      dir,
      name: 'Thing',
      message: 'now darker',
      history,
    })

    assert.match(seen.prompt, /now darker/)
    assert.match(seen.prompt, /index\.html/)
    assert.match(seen.prompt, /app\.js/)
    assert.deepEqual(seen.history, history)
    // The edit persona, not generation's — it must forbid deletions and
    // demand read-before-rewrite.
    assert.match(seen.system, /never delete/i)
    assert.match(seen.system, /read/i)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('excludes node_modules and .git from the listing', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    await fs.mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true })
    await fs.writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'z')
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.writeFile(path.join(dir, '.git/HEAD'), 'ref')

    let seen
    const runAgent = async (args) => {
      seen = args
      return said('ok')
    }

    await createEditor({ runAgent }).edit({ id: 'a', dir, message: 'hi' })

    assert.doesNotMatch(seen.prompt, /node_modules/)
    assert.doesNotMatch(seen.prompt, /\.git/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  // The same guarantee as the fixer: an edit operates on a folder that is
  // already the user's — failure must leave it exactly as found.
  await t.test('never deletes anything on a refusal', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const runAgent = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' } })

    const result = await createEditor({ runAgent }).edit({ id: 'a', dir, message: 'nope' })

    assert.equal(result.ok, false)
    assert.match(result.error, /declined/i)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('never deletes anything when the agent throws', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const runAgent = async () => {
      throw new Error('socket died')
    }

    const result = await createEditor({ runAgent }).edit({ id: 'a', dir, message: 'hi' })

    assert.equal(result.ok, false)
    assert.match(result.error, /socket died/)
    assert.deepEqual(await fs.readdir(dir), ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('refuses model-written paths that escape the app folder', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const runAgent = async ({ tools }) => {
      const refusal = await toolMap(tools).write_file.run({
        path: '../escaped.txt',
        content: 'nope',
      })
      assert.match(refusal, /outside/i)
      return said('ok')
    }

    await createEditor({ runAgent }).edit({ id: 'a', dir, message: 'hi' })

    const parent = path.dirname(dir)
    assert.equal((await fs.readdir(parent)).includes('escaped.txt'), false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('reports progress with the file being written', async () => {
    const dir = await appOnDisk({ 'index.html': 'x' })
    const events = []

    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'y' })
      return said('done')
    }

    await createEditor({ runAgent }).edit({
      id: 'a',
      dir,
      message: 'hi',
      onProgress: (e) => events.push(e),
    })

    const phases = events.map((e) => e.phase)
    assert.ok(phases.includes('reading'), phases.join(','))
    assert.ok(phases.includes('writing'), phases.join(','))
    assert.ok(phases.includes('done'), phases.join(','))
    assert.ok(events.some((e) => e.file === 'index.html'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('fails cleanly when the folder cannot be read', async () => {
    const result = await createEditor({ runAgent: async () => said('x') }).edit({
      id: 'gone',
      dir: path.join(os.tmpdir(), 'ld-edit-definitely-missing'),
      message: 'hi',
    })

    assert.equal(result.ok, false)
    assert.match(result.error, /cannot read/i)
  })
})
