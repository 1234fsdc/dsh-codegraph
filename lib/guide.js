// The system-prompt section for this plugin.
//
// CodeGraph ships a ~6.7 KB SERVER_INSTRUCTIONS blob with its MCP server. That
// text is written for the generic MCP surface — "there is a single tool", "init
// is a terminal command the user runs" — which contradicts a native DSH plugin
// that registers eleven codegraph_* tools and a real codegraph_init. Rather
// than forwarding it and appending a scope note (0.5.0-0.6.0), this build ships
// one tailored playbook: the official framing, anti-patterns and staleness
// rules are preserved, but every surface-specific claim is written for DSH, and
// the tool inventory is rendered from the live configuration.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guide.md'), 'utf8')

/** One line per optional tool, in the order they are registered. */
const TOOL_NOTES = {
  status: '- `codegraph_status` — is this project indexed, how big is the graph, and is the watcher alive.',
  sync: '- `codegraph_sync` — force an index update now (the watcher normally does this).',
  query: '- `codegraph_query` — symbol-name search returning JSON nodes; use when you only need locations, not source.',
  node: '- `codegraph_node` — one symbol with its caller/callee trail, or one file with line numbers.',
  files: '- `codegraph_files` — the indexed file tree with languages and symbol counts.',
  callers: '- `codegraph_callers` / `codegraph_callees` — direct call edges for one symbol.',
  callees: '- `codegraph_callers` / `codegraph_callees` — direct call edges for one symbol.',
  impact: '- `codegraph_impact` — what breaks if this symbol changes (traverses callers to a depth).',
  affected: '- `codegraph_affected` — which test files to run for a set of changed source files.'
}

function watcherNote(resident, state, hasSync) {
  // codegraph_sync is optional, so the guide must never send the model to a
  // tool this session did not register — that is the same class of
  // contradiction this whole rewrite exists to remove.
  const syncHint = hasSync ? ' Run `codegraph_sync` if you need the index updated immediately.' : ''
  const revive = hasSync
    ? ' Run `codegraph_sync` to revive it.'
    : ' Reload the plugin to restart the watcher.'
  if (!resident) {
    return '- This session runs without a resident watcher, so the index does not follow your edits: the index is only as fresh as the last explicit sync.'
  }
  if (state && state.state === 'fatal') {
    return '- The resident watcher gave up after repeated failures: `codegraph_explore` falls back to the CLI (slower, still correct).' + revive
  }
  if (state && (state.state === 'restarting' || state.restartScheduled)) {
    return '- The resident watcher is reconnecting after a crash; calls fall back to the CLI until it is back. The index itself keeps updating (the daemon owns the watcher).'
  }
  return '- A resident watcher re-indexes edits within about a second, so the index follows your edits without a manual sync.' + syncHint
}

/**
 * Render the system-prompt section for the current configuration.
 * @param {{surface: Set<string>, resident: boolean, watch?: object|null}} state
 */
export function renderGuide(state) {
  const surface = state.surface || new Set(['explore'])
  const extras = []
  for (const [key, note] of Object.entries(TOOL_NOTES)) {
    if (!surface.has(key)) continue
    // callers/callees share one line
    if (extras.includes(note)) continue
    extras.push(note)
  }
  const extraText = extras.length > 0
    ? '\n\n## Additional tools enabled in this session\n\n' + extras.join('\n')
    : '\n\n## Tool surface\n\nOnly `codegraph_explore` and `codegraph_init` are exposed in this session.'

  return TEMPLATE
    .replace('{{WATCHER}}', watcherNote(state.resident, state.watch, surface.has('sync')))
    .replace('{{EXTRA_TOOLS}}', extraText)
}

/** The playbook with no optional tools — used before the plugin is applied. */
export function staticGuide() {
  return renderGuide({ surface: new Set(['explore']), resident: true, watch: null })
}

/**
 * The codegraph_explore tool description, written for this plugin's actual
 * surface instead of forwarding the generic MCP-server text (0.5.0-0.7.1 kept
 * the official 582 chars and appended a DSH tail). Same principle as the
 * guide: the text may only reference tools this session actually registers.
 * @param {Set<string>} surface bare tool names, e.g. new Set(['explore','init'])
 * @param {boolean} resident whether the resident watcher is enabled
 */
export function exploreDescription(surface, resident) {
  const has = (name) => surface.has(name)
  const narrow = [
    ['query', '`codegraph_query` (find symbols by name)'],
    ['node', '`codegraph_node` (one symbol or file in detail)'],
    ['callers', '`codegraph_callers`'],
    ['callees', '`codegraph_callees`'],
    ['impact', '`codegraph_impact` (what breaks if this changes)'],
    ['files', '`codegraph_files` (project layout)'],
    ['affected', '`codegraph_affected` (which tests a changed file touches)']
  ].filter(([name]) => has(name)).map(([, label]) => label)

  const parts = [
    'PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. ' +
    'ONE capped call returns the verbatim, line-numbered source of the relevant symbols grouped by file — Read-equivalent: treat it as already Read, do NOT re-open those files — ' +
    'plus the call path among them (dynamic-dispatch hops included) and a blast-radius summary. ' +
    'Query with a natural-language question or a bag of symbol/file names. ' +
    'It replaces a grep/Read loop: more accurate context in far fewer tokens and round-trips.'
  ]
  if (narrow.length > 0) {
    parts.push(
      'Narrower lookups have their own tools in this session — ' + narrow.join(', ') +
      ' — reach for those when you already know the exact symbol or file; reach for explore when you do not.'
    )
  } else {
    parts.push('No narrower codegraph lookup tools are registered in this session, so explore is the entry point for every code question.')
  }
  if (resident) {
    parts.push('Served by the resident CodeGraph server: a file watcher re-indexes edits within about a second, so results reflect the current code without a manual sync.')
  } else if (has('sync')) {
    parts.push('Runs against the on-disk index: results are as fresh as the last `codegraph_sync`.')
  } else {
    parts.push('Runs against the on-disk index: results are as fresh as the last index build.')
  }
  if (has('init')) {
    parts.push('Requires an initialized project: if the project has no .codegraph/ index and the user asks to enable CodeGraph, run `codegraph_init` once first; it is bootstrap-only — never re-run it on an indexed project.')
  } else {
    parts.push('Requires an initialized project: if the project has no .codegraph/ index, it must be initialized (for example via `codegraph init` in a terminal) before this tool works.')
  }
  return parts.join(' ')
}
