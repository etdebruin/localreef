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

export const MODEL = 'claude-opus-5'

const SYSTEM_PROMPT = `You generate small, self-contained apps for Local Desktop, a desktop shell that runs local apps in windows.

Output:
- Write a single \`index.html\` with all markup, CSS and JavaScript inline. Only add more files if the app is genuinely large.
- Also write \`desktop.json\` containing a display \`name\` and a single-emoji \`icon\`.

Hard constraints:
- No network requests of any kind: no CDNs, no external fonts, no remote images. The app must work fully offline, and the desktop's CSP blocks outside origins. Use system fonts.
- Persist anything worth keeping in localStorage. The app runs on its own origin, so its storage is private to it.

Quality bar:
- Build the whole thing. Every control you render must work — no stubs, no "coming soon", no placeholder handlers.
- Design it deliberately: considered spacing, a real type hierarchy, a restrained palette. Avoid generic AI-looking output — no purple-on-white gradients, no rows of unstyled default form controls.
- Handle the empty state: say what the app is for and how to begin.
- Keyboard basics matter: Enter submits, Escape closes, focus is visible.

Work by calling write_file. When every file is written, stop and say in one sentence what you built.`

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
      final = await runAgent({ prompt, tools, dir, id, onProgress })
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

  return { generate }
}

/**
 * The real model-backed runner. Kept separate from createGenerator so the
 * generation flow is testable without touching the network.
 */
export function createClaudeRunner({ apiKey, model = MODEL } = {}) {
  return async function runAgent({ prompt, tools, onProgress = () => {} }) {
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
      // `high` rather than `xhigh`: the quality difference on an app this size
      // does not pay for the extra latency in an interactive flow.
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
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
