import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createSettingsStore,
  resolveApiKey,
  expandHome,
  DEFAULT_GATEWAY_PORT,
} from '../src/core/settings.js'

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ld-settings-'))
}

test('createSettingsStore', async (t) => {
  await t.test('returns defaults when there is no file yet', async () => {
    const dir = await scratch()
    const store = createSettingsStore(path.join(dir, 'settings.json'))

    assert.deepEqual(await store.read(), {
      appsFolder: null,
      anthropicApiKey: null,
      backgroundId: null,
      ownerName: null,
      gatewayPort: null,
    })
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('persists the owner name for the startup hello', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')

    await createSettingsStore(file).update({ ownerName: '  Etienne ' })
    assert.equal((await createSettingsStore(file).read()).ownerName, 'Etienne')
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('persists a value across instances', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    const target = path.join(dir, 'Code')
    await fs.mkdir(target)

    await createSettingsStore(file).update({ appsFolder: target })
    assert.equal((await createSettingsStore(file).read()).appsFolder, target)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('update merges rather than replacing', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    const store = createSettingsStore(file)

    await store.update({ anthropicApiKey: 'sk-ant-abc' })
    await store.update({ appsFolder: dir })

    const settings = await store.read()
    assert.equal(settings.anthropicApiKey, 'sk-ant-abc')
    assert.equal(settings.appsFolder, dir)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('an empty string clears a value back to null', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    const store = createSettingsStore(file)

    await store.update({ anthropicApiKey: 'sk-ant-abc' })
    await store.update({ anthropicApiKey: '  ' })

    assert.equal((await store.read()).anthropicApiKey, null)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('resolves the apps folder to an absolute path', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    await fs.mkdir(path.join(dir, 'Code'))

    // Written with a trailing slash; read back normalised.
    await createSettingsStore(file).update({ appsFolder: `${path.join(dir, 'Code')}/` })
    assert.equal((await createSettingsStore(file).read()).appsFolder, path.join(dir, 'Code'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('survives a corrupt settings file', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    await fs.writeFile(file, '{ not json')

    // Same failure posture as links.json: an unreadable settings file must
    // never stop the desktop from starting.
    assert.deepEqual(await createSettingsStore(file).read(), {
      appsFolder: null,
      anthropicApiKey: null,
      backgroundId: null,
      ownerName: null,
      gatewayPort: null,
    })
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('ignores unknown keys rather than storing them', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'settings.json')
    const store = createSettingsStore(file)

    await store.update({ nonsense: 'x', anthropicApiKey: 'sk-ant-abc' })
    const settings = await store.read()

    assert.equal(settings.nonsense, undefined)
    assert.equal(settings.anthropicApiKey, 'sk-ant-abc')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

// The gateway port IS every app's identity on disk: localStorage keys to
// scheme+host+port, so the port changing across launches strands every app's
// data under an origin nothing will visit again. It happened — First Chair
// lost a weigh-in to listen(0). The port must persist.
test('gatewayPort', async (t) => {
  await t.test('persists through update and read', async () => {
    const dir = await scratch()
    const store = createSettingsStore(path.join(dir, 'settings.json'))

    await store.update({ gatewayPort: 7333 })
    assert.equal((await store.read()).gatewayPort, 7333)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('is null until something sets it', async () => {
    const dir = await scratch()
    const store = createSettingsStore(path.join(dir, 'settings.json'))
    assert.equal((await store.read()).gatewayPort, null)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('survives an unrelated settings write', async () => {
    const dir = await scratch()
    const store = createSettingsStore(path.join(dir, 'settings.json'))

    await store.update({ gatewayPort: 7333 })
    await store.update({ ownerName: 'Etienne' })
    assert.equal((await store.read()).gatewayPort, 7333)
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('refuses garbage rather than binding to it', async () => {
    const dir = await scratch()
    const store = createSettingsStore(path.join(dir, 'settings.json'))

    for (const junk of ['not-a-port', 3.14, 0, -1, 70000, true]) {
      await store.update({ gatewayPort: junk })
      assert.equal((await store.read()).gatewayPort, null, `accepted ${JSON.stringify(junk)}`)
    }
    await fs.rm(dir, { recursive: true, force: true })
  })

  await t.test('the default is a real unprivileged port', () => {
    assert.equal(Number.isInteger(DEFAULT_GATEWAY_PORT), true)
    assert.ok(DEFAULT_GATEWAY_PORT >= 1024 && DEFAULT_GATEWAY_PORT <= 65535)
  })
})

test('expandHome', async (t) => {
  await t.test('expands a leading tilde', () => {
    assert.equal(expandHome('~/Code'), path.join(os.homedir(), 'Code'))
  })

  await t.test('leaves an absolute path alone', () => {
    assert.equal(expandHome('/Users/someone/Code'), '/Users/someone/Code')
  })

  await t.test('does not expand a tilde inside the path', () => {
    assert.equal(expandHome('/tmp/~backup'), '/tmp/~backup')
  })
})

test('resolveApiKey', async (t) => {
  await t.test('prefers the configured key over the environment', () => {
    const key = resolveApiKey({ anthropicApiKey: 'sk-ant-settings' }, { ANTHROPIC_API_KEY: 'sk-ant-env' })
    assert.equal(key, 'sk-ant-settings')
  })

  await t.test('falls back to the environment when nothing is configured', () => {
    // This is the Finder/Dock case: launched with no shell env, the settings
    // file is the only source; launched from a terminal, the env still works.
    assert.equal(resolveApiKey({ anthropicApiKey: null }, { ANTHROPIC_API_KEY: 'sk-ant-env' }), 'sk-ant-env')
  })

  await t.test('is null when neither has a key', () => {
    assert.equal(resolveApiKey({ anthropicApiKey: null }, {}), null)
  })
})
