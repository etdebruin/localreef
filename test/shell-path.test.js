import test from 'node:test'
import assert from 'node:assert/strict'

import { PATH_MARKER, parseShellPath, withFallbacks } from '../src/core/shell-path.js'

test('parseShellPath', async (t) => {
  await t.test('extracts the path after the marker', () => {
    assert.equal(parseShellPath(`${PATH_MARKER}/usr/bin:/bin`), '/usr/bin:/bin')
  })

  await t.test('ignores anything a login shell printed first', () => {
    // macOS Terminal's session restore writes "Restored session: ..." to
    // *stdout* from an interactive zsh. Without a marker that line was trimmed
    // in as part of PATH, turning the first few entries into garbage.
    const noisy = `Restored session: Fri Aug  7 21:53:16 MDT 2026\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin`
    assert.equal(parseShellPath(noisy), '/opt/homebrew/bin:/usr/bin')
  })

  await t.test('ignores a trailing newline from the shell', () => {
    assert.equal(parseShellPath(`${PATH_MARKER}/usr/bin\n`), '/usr/bin')
  })

  await t.test('takes the last marker if an rc file echoed one', () => {
    assert.equal(parseShellPath(`${PATH_MARKER}/a\n${PATH_MARKER}/b:/c`), '/b:/c')
  })

  await t.test('returns null when the marker never arrived', () => {
    // A shell that died, timed out, or printed only noise. The caller has to
    // be able to tell that apart from an empty PATH.
    assert.equal(parseShellPath('Restored session: whatever'), null)
    assert.equal(parseShellPath(''), null)
    assert.equal(parseShellPath(null), null)
  })

  await t.test('returns null for a marker with nothing after it', () => {
    assert.equal(parseShellPath(PATH_MARKER), null)
  })
})

test('withFallbacks', async (t) => {
  await t.test('keeps the resolved path first', () => {
    const merged = withFallbacks('/my/bin:/usr/bin').split(':')
    assert.equal(merged[0], '/my/bin')
    assert.equal(merged[1], '/usr/bin')
  })

  await t.test('appends the usual install locations', () => {
    // The point of this: when the login shell times out, the bare GUI PATH is
    // /usr/bin:/bin and every uv/node/pnpm app fails with "command not found".
    const merged = withFallbacks('/usr/bin:/bin')
    assert.ok(merged.includes('/opt/homebrew/bin'), merged)
    assert.ok(merged.includes('/usr/local/bin'), merged)
  })

  await t.test('never repeats an entry', () => {
    const entries = withFallbacks('/opt/homebrew/bin:/usr/bin').split(':')
    assert.equal(new Set(entries).size, entries.length, entries.join(','))
  })

  await t.test('drops empty segments', () => {
    assert.ok(!withFallbacks('/usr/bin::/bin:').split(':').includes(''))
  })

  await t.test('works from nothing at all', () => {
    const merged = withFallbacks(null)
    assert.ok(merged.includes('/opt/homebrew/bin'))
    assert.ok(merged.includes('/usr/bin'))
  })
})
