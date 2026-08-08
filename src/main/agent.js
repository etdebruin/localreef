/**
 * App generation.
 *
 * Takes a description, scaffolds a folder, and lets the model write the app
 * into it through a filesystem toolset scoped to that folder. The model writes
 * the paths, so every one is treated as untrusted and resolved against the app
 * root before anything touches disk.
 *
 * The default target is a single self-contained index.html: no install step,
 * no process to supervise, and it opens the instant the icon appears.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { slugify, uniqueId } from '../core/slug.js'

/**
 * One model per task, chosen deliberately rather than one constant for all.
 *
 * `generate`, `fix`, and `edit` all write real files — for a linked app, the
 * user's actual project — so they stay on Opus: a wrong edit costs more than
 * a slow one. `route` is the v1.5 ⌘K intent classifier ("open an existing app, or
 * build one?"); it is a tiny decision felt on every invocation, so it rides
 * the fast tier. No call site uses it yet — it is here so the next one has to
 * pick a tier instead of inheriting whatever generation uses.
 */
export const MODELS = {
  generate: 'claude-opus-5',
  fix: 'claude-opus-5',
  edit: 'claude-opus-5',
  route: 'claude-haiku-4-5',
}

/**
 * The effort knob is Opus/Sonnet-only — Haiku 4.5 rejects `output_config.
 * effort` with a 400, so a Haiku call reusing the Opus request shape would
 * fail before the model saw anything. `high` rather than `xhigh`: the quality
 * difference on an app this size does not pay for the extra latency in an
 * interactive flow.
 */
export function outputConfig(model) {
  if (String(model).startsWith('claude-haiku')) return {}
  return { output_config: { effort: 'high' } }
}

const SYSTEM_PROMPT = `You generate small, self-contained apps for Local Reef, a desktop shell that runs local apps in windows.

Output:
- Write a single \`index.html\` with all markup, CSS and JavaScript inline. Only add more files if the app is genuinely large.
- Also write \`reef.json\` containing a display \`name\` and a single-emoji \`icon\`.

Hard constraints:
- No network requests of any kind: no CDNs, no external fonts, no remote images. The app must work fully offline, and the desktop's CSP blocks outside origins. Use system fonts.
- Persist anything worth keeping in localStorage. The app runs on its own origin, so its storage is private to it.

Quality bar:
- Build the whole thing. Every control you render must work — no stubs, no "coming soon", no placeholder handlers.
- Design it deliberately: considered spacing, a real type hierarchy, a restrained palette. Avoid generic AI-looking output — no purple-on-white gradients, no rows of unstyled default form controls.
- Handle the empty state: say what the app is for and how to begin.
- Keyboard basics matter: Enter submits, Escape closes, focus is visible.

Work by calling write_file. When every file is written, stop and say in one sentence what you built.`

/**
 * The request messages for a turn: earlier turns, then the new prompt.
 *
 * History is plain text turns only — user messages and the assistant's final
 * reply, never tool_use/tool_result or thinking blocks. The files on disk are
 * the real state and every turn's prompt carries a fresh listing, so replaying
 * the tool transcript buys nothing and resending thinking blocks is exactly
 * the kind of block-replay the API is picky about. Text turns sidestep all of
 * it, and make truncating old history safe.
 */
export function buildMessages(history, prompt) {
  return [...(history ?? []), { role: 'user', content: prompt }]
}

/** Resolve a model-supplied path against the app root, or refuse it. */
function resolveWithin(root, candidate) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) return null

  const rootAbs = path.resolve(root)
  const target = path.resolve(rootAbs, candidate)
  const rel = path.relative(rootAbs, target)

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

export function createAppTools(dir, { onFile = () => {} } = {}) {
  const written = new Set()
  const refuse = (p) => `Refused: "${p}" is outside the app directory. Use a relative path.`

  const tools = [
    {
      name: 'write_file',
      description:
        'Create or overwrite a file in the app directory. Use a relative path such as "index.html".',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path within the app directory' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
      run: async ({ path: relPath, content }) => {
        const target = resolveWithin(dir, relPath)
        if (!target) return refuse(relPath)

        const body = String(content ?? '')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, body, 'utf8')

        const rel = path.relative(dir, target)
        written.add(rel)
        onFile(rel)
        return `Wrote ${rel} (${body.length} bytes)`
      },
    },

    {
      name: 'read_file',
      description: 'Read a file you have already written, to revise it.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      run: async ({ path: relPath }) => {
        const target = resolveWithin(dir, relPath)
        if (!target) return refuse(relPath)
        try {
          return await fs.readFile(target, 'utf8')
        } catch {
          return `No such file: ${relPath}`
        }
      },
    },

    {
      name: 'list_files',
      description: 'List the files written so far.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: async () => {
        try {
          const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
          const files = entries
            .filter((e) => e.isFile())
            .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
          return files.length ? files.join('\n') : '(empty)'
        } catch {
          return '(empty)'
        }
      },
    },
  ]

  return { tools, written }
}

/**
 * Every file in the app, relative to its root — what a fix or edit turn shows
 * the model so it knows what exists before reading anything. Dependency and
 * VCS internals are noise at best and enormous at worst.
 */
async function listAppFiles(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('.git/'))
}

/** The assistant's reply text, for a chat bubble. Never empty. */
function finalText(message) {
  const text = (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text || '(made changes)'
}

async function existingIds(appsDir) {
  try {
    const entries = await fs.readdir(appsDir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export function createGenerator({ appsDir, runAgent }) {
  async function generate({ prompt, onProgress = () => {} }) {
    const id = uniqueId(slugify(prompt), await existingIds(appsDir))
    const dir = path.join(appsDir, id)

    onProgress({ phase: 'scaffolding', id })
    await fs.mkdir(dir, { recursive: true })

    const { tools, written } = createAppTools(dir, {
      onFile: (file) => onProgress({ phase: 'writing', id, file }),
    })

    // Any failure removes the folder: a half-written app that shows up as a
    // broken icon is worse than one that never appeared.
    const abandon = async (error) => {
      await fs.rm(dir, { recursive: true, force: true })
      return { ok: false, id, error }
    }

    let final
    try {
      // The agent's own events ('thinking') do not know which build they
      // belong to; stamp the id so a caller juggling several can route them.
      final = await runAgent({
        prompt,
        tools,
        dir,
        id,
        onProgress: (event) => onProgress({ ...event, id }),
      })
    } catch (err) {
      return abandon(err?.message ?? String(err))
    }

    // A 200 with stop_reason "refusal" is not an exception — check it before
    // trusting anything about the result.
    if (final?.stop_reason === 'refusal') {
      const category = final.stop_details?.category
      return abandon(
        `The model declined this request${category ? ` (${category})` : ''}. Try rephrasing it.`,
      )
    }

    if (written.size === 0) {
      return abandon('The agent wrote no files.')
    }

    onProgress({ phase: 'done', id })
    return { ok: true, id, dir, files: [...written] }
  }

  /**
   * Kick off a build and hand back its identity immediately.
   *
   * A generation is minutes long; nothing should have to wait on it just to
   * learn which app is being built. `id` resolves as soon as the folder has a
   * name — the 'scaffolding' event, first thing generate does — and `done`
   * settles with the full result when the agent finishes. The race covers the
   * one path where scaffolding never fires: generate rejecting outright.
   */
  function start({ prompt, onProgress = () => {} }) {
    let announce
    const announced = new Promise((resolve) => {
      announce = resolve
    })

    const done = generate({
      prompt,
      onProgress: (event) => {
        if (event.phase === 'scaffolding') announce(event.id)
        onProgress(event)
      },
    })

    return { id: Promise.race([announced, done.then((result) => result.id)]), done }
  }

  return { generate, start }
}

const FIX_SYSTEM_PROMPT = `You repair a broken app for Local Reef, a desktop shell that runs local apps in windows.

You are given the failure and the app's current files. Read what you need with read_file, then write corrected files with write_file.

How to work:
- Fix the specific failure described. Do not redesign the app, rename things, or "improve" code that is not implicated in the error.
- Change as little as possible. A reader should be able to see exactly what you fixed and why.
- Read a file before you rewrite it. write_file replaces the whole file, so you must preserve everything you are not deliberately changing.
- If the error is a missing dependency or a broken command, prefer fixing the app so it needs neither, rather than adding an install step.

The same constraints as any Local Reef app still apply: no network requests, no CDNs, works offline, state in localStorage.

When the fix is complete, stop and say in one sentence what was wrong and what you changed. If you cannot determine the cause from the evidence, say so plainly instead of guessing at a rewrite.`

/**
 * Repairing an app that already exists.
 *
 * Deliberately not part of createGenerator: generation owns the folder it
 * creates and deletes it on failure, but a fix operates on a folder that is
 * already the user's — for a linked app it is their actual project checkout.
 * Nothing here ever removes anything.
 */
export function createFixer({ runAgent }) {
  async function fix({ id, dir, name, error, logs = [], onProgress = () => {} }) {
    onProgress({ phase: 'reading', id })

    let listing = []
    try {
      listing = await listAppFiles(dir)
    } catch (err) {
      return { ok: false, id, error: `Cannot read the app folder: ${err.message}` }
    }

    const { tools, written } = createAppTools(dir, {
      onFile: (file) => onProgress({ phase: 'writing', id, file }),
    })

    const prompt = [
      `The app "${name ?? id}" failed to start.`,
      '',
      `Failure: ${error ?? 'unknown'}`,
      logs.length ? `\nOutput:\n${logs.slice(-40).join('\n')}` : '',
      `\nFiles in the app:\n${listing.length ? listing.join('\n') : '(none)'}`,
    ].join('\n')

    let final
    try {
      final = await runAgent({ prompt, tools, dir, id, onProgress, system: FIX_SYSTEM_PROMPT })
    } catch (err) {
      return { ok: false, id, error: err?.message ?? String(err) }
    }

    if (final?.stop_reason === 'refusal') {
      const category = final.stop_details?.category
      return {
        ok: false,
        id,
        error: `The model declined this request${category ? ` (${category})` : ''}.`,
      }
    }

    if (written.size === 0) {
      return { ok: false, id, error: 'The agent made no changes.' }
    }

    onProgress({ phase: 'done', id })
    return { ok: true, id, dir, files: [...written] }
  }

  return { fix }
}

const EDIT_SYSTEM_PROMPT = `You refine an existing app for Local Reef, a desktop shell that runs local apps in windows. You are in an ongoing conversation with the app's owner: earlier turns are in the conversation, and the files on disk are the current truth — trust the files over your memory of them.

How to work:
- Do what this message asks, and only that. Minimal diffs: do not redesign, rename, or "improve" code the request does not touch.
- Read a file before you rewrite it. write_file replaces the whole file, so you must preserve everything you are not deliberately changing.
- Never delete or empty a file, and never remove a feature the owner did not ask you to remove.
- Keep reef.json's name and icon unless asked to change them.
- If the message is a question rather than a change request, answer it from the files without writing anything.

The same constraints as any Local Reef app still apply: no network requests, no CDNs, works fully offline, system fonts, state in localStorage.

When you are done, reply in one or two sentences — your reply is shown in a chat pane next to the running app.`

/**
 * Conversational refinement of an app the user built with ⌘K.
 *
 * Deliberately separate from createFixer even though the shape rhymes: a fix
 * turn is driven by a crash and must change something; an edit turn is driven
 * by a person and may legitimately change nothing (a question is a valid
 * turn). What they share is the guarantee — this operates on a folder that
 * already exists, and **nothing here ever removes anything**.
 *
 * The caller owns the conversation: it passes `history` in and appends the
 * returned `reply` to it after a successful turn. A failed turn is the
 * caller's cue to leave history untouched so the user can rephrase.
 */
export function createEditor({ runAgent }) {
  async function edit({ id, dir, name, message, history = [], onProgress = () => {} }) {
    onProgress({ phase: 'reading', id })

    let listing = []
    try {
      listing = await listAppFiles(dir)
    } catch (err) {
      return { ok: false, id, error: `Cannot read the app folder: ${err.message}` }
    }

    const { tools, written } = createAppTools(dir, {
      onFile: (file) => onProgress({ phase: 'writing', id, file }),
    })

    const prompt = [
      message,
      '',
      `The app is "${name ?? id}". Files on disk:`,
      listing.length ? listing.join('\n') : '(none)',
    ].join('\n')

    let final
    try {
      final = await runAgent({ prompt, tools, dir, id, onProgress, system: EDIT_SYSTEM_PROMPT, history })
    } catch (err) {
      return { ok: false, id, error: err?.message ?? String(err) }
    }

    if (final?.stop_reason === 'refusal') {
      const category = final.stop_details?.category
      return {
        ok: false,
        id,
        error: `The model declined this request${category ? ` (${category})` : ''}.`,
      }
    }

    onProgress({ phase: 'done', id })
    return { ok: true, id, dir, files: [...written], reply: finalText(final) }
  }

  return { edit }
}

/**
 * The real model-backed runner. Kept separate from createGenerator so the
 * generation flow is testable without touching the network.
 */
export function createClaudeRunner({ apiKey, model = MODELS.generate } = {}) {
  return async function runAgent({ prompt, tools, onProgress = () => {}, system, history }) {
    const [{ default: Anthropic }, { betaTool }] = await Promise.all([
      import('@anthropic-ai/sdk'),
      import('@anthropic-ai/sdk/helpers/beta/json-schema'),
    ])

    const client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      // A single-file app is one long request; the default can expire under a
      // slow generation. Milliseconds in this SDK.
      timeout: 15 * 60 * 1000,
      maxRetries: 2,
    })

    const params = {
      model,
      // Caps thinking *and* output together. 32k is ample for a self-contained
      // app and keeps the request short enough to survive the connection.
      max_tokens: 32000,
      ...outputConfig(model),
      system: system ?? SYSTEM_PROMPT,
      messages: buildMessages(history, prompt),
      tools: tools.map((tool) =>
        betaTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          run: tool.run,
        }),
      ),
      // Streaming is required at this max_tokens or the request can outlive
      // the HTTP timeout.
      stream: true,
    }

    const run = async (extra) => {
      const runner = client.beta.messages.toolRunner({ ...params, ...extra })
      let final

      for await (const stream of runner) {
        // Drain events rather than only awaiting the final message: it keeps
        // the socket reading steadily through a long generation, and gives the
        // palette something honest to show while the model works.
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            onProgress({ phase: 'thinking', tool: event.content_block.name })
          }
        }
        final = await stream.finalMessage()
      }

      return final
    }

    // Server-side fallbacks re-serve a policy decline on another model. If the
    // account or SDK build does not accept the parameter, fall back to a plain
    // request rather than failing the generation outright.
    try {
      return await run({
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
    } catch (err) {
      if (!/fallback|beta/i.test(err?.message ?? '')) throw err
      return run({})
    }
  }
}
