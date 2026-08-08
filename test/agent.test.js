import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { MODELS, createAppTools, createGenerator, outputConfig } from '../src/main/agent.js'

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ld-agent-'))
}

function toolMap(tools) {
  return Object.fromEntries(tools.map((t) => [t.name, t]))
}

test('createAppTools', async (t) => {
  await t.test('writes a file inside the app directory', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    const result = await toolMap(tools).write_file.run({ path: 'index.html', content: '<h1>hi</h1>' })

    assert.match(result, /index\.html/)
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<h1>hi</h1>')
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('creates intermediate directories', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    await toolMap(tools).write_file.run({ path: 'assets/css/main.css', content: 'body{}' })

    assert.equal(await fs.readFile(path.join(dir, 'assets/css/main.css'), 'utf8'), 'body{}')
    await fs.rm(dir, { recursive: true, force: true })
  })

  // The model writes these paths, so they are untrusted.
  await t.test('refuses to escape the app directory', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    const write = toolMap(tools).write_file

    for (const bad of ['../escaped.txt', '../../etc/passwd', '/etc/passwd']) {
      const result = await write.run({ path: bad, content: 'nope' })
      assert.match(result, /outside|refus|invalid/i, `allowed: ${bad}`)
    }

    const parent = path.dirname(dir)
    const leaked = await fs.readdir(parent)
    assert.equal(leaked.includes('escaped.txt'), false, 'wrote outside the app dir')
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('reads back a file it wrote', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    const map = toolMap(tools)
    await map.write_file.run({ path: 'a.txt', content: 'hello' })

    assert.match(await map.read_file.run({ path: 'a.txt' }), /hello/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('reports a missing file instead of throwing', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    assert.match(await toolMap(tools).read_file.run({ path: 'nope.txt' }), /no such|not found/i)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('lists what has been written', async () => {
    const dir = await tmpDir()
    const { tools } = createAppTools(dir)
    const map = toolMap(tools)
    await map.write_file.run({ path: 'index.html', content: 'x' })
    await map.write_file.run({ path: 'sub/app.js', content: 'y' })

    const listing = await map.list_files.run({})
    assert.match(listing, /index\.html/)
    assert.match(listing, /sub\/app\.js/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('reports written files and notifies progress', async () => {
    const dir = await tmpDir()
    const seen = []
    const { tools, written } = createAppTools(dir, { onFile: (p) => seen.push(p) })
    await toolMap(tools).write_file.run({ path: 'index.html', content: 'x' })

    assert.deepEqual(seen, ['index.html'])
    assert.deepEqual([...written], ['index.html'])
    await fs.rm(dir, { recursive: true, force: true })
  })
})

test('createGenerator', async (t) => {
  await t.test('creates the app folder and runs the agent against it', async () => {
    const appsDir = await tmpDir()

    // Stand-in for the model: writes the files a real run would write.
    const runAgent = async ({ tools }) => {
      const map = toolMap(tools)
      await map.write_file.run({ path: 'index.html', content: '<h1>Mileage</h1>' })
      await map.write_file.run({
        path: 'reef.json',
        content: JSON.stringify({ name: 'Mileage', icon: '🏃' }),
      })
      return { stop_reason: 'end_turn' }
    }

    const generator = createGenerator({ appsDir, runAgent })
    const result = await generator.generate({ prompt: 'a tool to track my running mileage' })

    assert.equal(result.ok, true)
    assert.equal(result.id, 'track-running-mileage')
    // Both sides sorted: the expectation should not depend on where the
    // manifest filename happens to fall alphabetically.
    assert.deepEqual(result.files.sort(), ['index.html', 'reef.json'].sort())
    assert.match(
      await fs.readFile(path.join(appsDir, result.id, 'index.html'), 'utf8'),
      /Mileage/,
    )
    await fs.rm(appsDir, { recursive: true, force: true })
  })

  await t.test('avoids colliding with an existing app id', async () => {
    const appsDir = await tmpDir()
    await fs.mkdir(path.join(appsDir, 'budget'))

    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'x' })
      return { stop_reason: 'end_turn' }
    }

    const generator = createGenerator({ appsDir, runAgent })
    const result = await generator.generate({ prompt: 'budget' })

    assert.equal(result.id, 'budget-2')
    await fs.rm(appsDir, { recursive: true, force: true })
  })

  await t.test('surfaces a refusal rather than leaving a broken app behind', async () => {
    const appsDir = await tmpDir()
    const runAgent = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' } })

    const generator = createGenerator({ appsDir, runAgent })
    const result = await generator.generate({ prompt: 'something disallowed' })

    assert.equal(result.ok, false)
    assert.match(result.error, /declined|refus/i)
    assert.deepEqual(await fs.readdir(appsDir), [], 'left an empty folder behind')
    await fs.rm(appsDir, { recursive: true, force: true })
  })

  await t.test('fails cleanly when the agent writes nothing', async () => {
    const appsDir = await tmpDir()
    const runAgent = async () => ({ stop_reason: 'end_turn' })

    const generator = createGenerator({ appsDir, runAgent })
    const result = await generator.generate({ prompt: 'empty' })

    assert.equal(result.ok, false)
    assert.match(result.error, /no files/i)
    assert.deepEqual(await fs.readdir(appsDir), [])
    await fs.rm(appsDir, { recursive: true, force: true })
  })

  await t.test('reports progress as it goes', async () => {
    const appsDir = await tmpDir()
    const events = []

    const runAgent = async ({ tools }) => {
      await toolMap(tools).write_file.run({ path: 'index.html', content: 'x' })
      return { stop_reason: 'end_turn' }
    }

    const generator = createGenerator({ appsDir, runAgent })
    await generator.generate({
      prompt: 'a timer',
      onProgress: (event) => events.push(event),
    })

    const phases = events.map((e) => e.phase)
    assert.ok(phases.includes('scaffolding'), phases.join(','))
    assert.ok(phases.includes('writing'), phases.join(','))
    assert.ok(phases.includes('done'), phases.join(','))
    assert.ok(events.some((e) => e.file === 'index.html'))
    await fs.rm(appsDir, { recursive: true, force: true })
  })
})

test('model selection', async (t) => {
  await t.test('each task names its model tier explicitly', () => {
    // Generation and fixing both edit real files — a wrong edit is worse than
    // a slow one, so both stay on Opus. Routing is a classification felt on
    // every ⌘K keystroke, so it rides the fast tier.
    assert.equal(MODELS.generate, 'claude-opus-5')
    assert.equal(MODELS.fix, 'claude-opus-5')
    assert.equal(MODELS.route, 'claude-haiku-4-5')
  })

  await t.test('effort is requested only from models that accept it', () => {
    // Haiku 4.5 rejects output_config.effort with a 400 — a routing call that
    // reuses the Opus request shape would fail before the model saw anything.
    assert.deepEqual(outputConfig(MODELS.generate), { output_config: { effort: 'high' } })
    assert.deepEqual(outputConfig(MODELS.fix), { output_config: { effort: 'high' } })
    assert.deepEqual(outputConfig(MODELS.route), {})
  })
})
