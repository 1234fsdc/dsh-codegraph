// dsh-codegraph-plugin — native DSH tools around the bundled CodeGraph CLI.
//
// Query tools run against a resident `codegraph serve --mcp` process so the
// per-project daemon (and its file watcher) stays alive: edits are re-indexed
// automatically within about a second, the same behaviour as the official
// `codegraph install` MCP server. codegraph_explore is served directly over
// MCP; the remaining tools keep their existing CLI output shapes.
//
// The tool surface follows the official `codegraph install` default: only
// codegraph_explore is listed, because the presence of the narrower tools
// steers the model toward mis-picks (the official A/B data: a search-only
// surface turned a 43% saving on express into a 107% loss). codegraph_init
// stays visible as the bootstrap tool — autoInit is off by default, so an
// unindexed project needs a way to build its index without editing plugin
// config. Configure `tools` to expose the rest.
//
// The system-prompt section is a DSH-specific playbook (lib/guide.md) rendered
// by lib/guide.js: it keeps the official framing, anti-patterns and staleness
// rules, but every surface-specific claim ("there is a single tool", "init is a
// terminal command") is rewritten for a native plugin that registers eleven
// codegraph_* tools, including a real codegraph_init. The tool inventory in the
// text follows the configured surface, so the prompt never advertises a tool
// that is not registered.

import { resolve } from 'node:path'
import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { assertLaunched, formatOutcome, runCodegraph } from './cli.js'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  EXPLORE_MAX_OUTPUT_CHARS,
  exploreCallBudget,
  exploreOutputBudget,
  hardCeilingFor,
  truncateMiddle
} from './budget.js'
import { probeIndex } from './readiness.js'
import { countFiles, getWorkspaceRoot, isProjectRoot } from './workspace.js'
import {
  configureResident,
  ensureResident,
  residentStatus,
  stopAllResidents,
  stopResident,
  stopResidentSweeper,
  verifyResident,
  warmResident
} from './resident.js'
import { listDaemonRecords, stopDaemon, verifiedDaemons } from './daemon.js'
import { buildExploreDiagnostics, extractExploreFiles } from './diagnostics.js'
import { freshnessWarning, indexTimestamp, staleFilesSince } from './freshness.js'
import { renderGuide, exploreDescription } from './guide.js'

/**
 * A condition the caller can act on: no index yet, a path that is not a
 * directory, a virtual asar path. Reported as a normal tool result carrying
 * guidance, never as an isError — the official CodeGraph server follows the
 * same rule because "an isError: true early in a session teaches the agent the
 * toolset is broken and it stops calling codegraph entirely (observed
 * repeatedly)".
 */
class ExpectedFailure extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExpectedFailure'
    this.expected = true
  }
}

const ASAR_PATH = /\.asar(?:[\\/]|$)/i

/**
 * CodeGraph indexes real directories on disk. Validate before spawning anything:
 * `spawn` fails with ENOENT when its cwd is virtual or missing, and the model
 * cannot tell that apart from "CodeGraph is broken", so it stops calling the
 * tool. DSH puts its own checkout (an app.asar path) in every session prompt, so
 * the model will pass that path sooner or later.
 *
 * @param {string} root absolute path
 */
function assertOnDiskDirectory(root) {
  if (ASAR_PATH.test(root)) {
    throw new ExpectedFailure(
      'CodeGraph cannot index ' + root + ': it is a virtual path inside an .asar archive, not a directory on disk.\n' +
      'Use the built-in read/grep/glob tools for that path, and tell the user that CodeGraph only covers real on-disk projects.'
    )
  }
  let stat = null
  try { stat = statSync(root) } catch { /* reported below */ }
  if (stat && stat.isDirectory()) return
  throw new ExpectedFailure(
    'CodeGraph cannot index ' + root + ': ' + (stat ? 'it is not a directory' : 'no such directory on disk') + '.\n' +
    'Pass a real project directory, omit `path` to use the session workspace, or use the built-in read/grep/glob tools instead.'
  )
}

export const name = 'dsh-codegraph-plugin'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

export const Config = z.object({
  // Initialize CodeGraph automatically for a plausible project on first use.
  // Off by default to match the official `codegraph install` ("wires up agents
  // only"); set autoInit: true for install-and-go behavior.
  autoInit: z.boolean().default(false),
  maxAutoInitFiles: z.number().default(5000),
  initTimeoutMs: z.number().default(600000),
  queryTimeoutMs: z.number().default(120000),
  syncTimeoutMs: z.number().default(300000),
  // 0 = derive the per-call file cap from the index size (official explore
  // tiers: 4/5/8 files for <150 / <500 / larger repos).
  maxFiles: z.number().default(0),
  // Per-call character budget for CLI answers. The CLI itself prints 97 KB for
  // `files --json` on a mid-size repo and nothing capped it below 8 MB, so the
  // model re-paid for that output every turn.
  maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS),
  // explore answers get the official larger budget (tiered by index size).
  exploreMaxOutputChars: z.number().default(EXPLORE_MAX_OUTPUT_CHARS),
  // Ask the resident server for cross-call source dedup (CODEGRAPH_EXPLORE_DEDUP).
  // Only safe for a durable single-connection context.
  exploreDedup: z.boolean().default(false),
  // Append a per-file accounting block to explore answers.
  exploreDiagnostics: z.boolean().default(false),
  // Warn when an answered file changed on disk after the index was written.
  freshnessCheck: z.boolean().default(true),
  // Include the raw status JSON dump after the summary.
  statusJson: z.boolean().default(false),
  contextMaxNodes: z.number().default(20),
  contextIncludeCode: z.boolean().default(true),
  guideSearch: z.boolean().default(true),
  // Which tools are listed to the agent. Defaults to the official surface:
  // only `explore` (plus the always-on `init` bootstrap). Accepts "all", a
  // comma-separated string, or a list of short names, e.g. ["explore", "query"].
  tools: z.union([z.string(), z.array(z.string())]).default(['explore']),
  // Keep a resident CodeGraph MCP server (daemon + file watcher) per workspace.
  resident: z.boolean().default(true),
  maxResidentProjects: z.number().default(3),
  residentStartTimeoutMs: z.number().default(30000),
  // Reap a resident server after this many milliseconds without a tool call.
  // 0 keeps servers for the whole DSH process lifetime. 5 min matches the
  // official daemon's idle shutdown; the launcher alone holds ~280 MB.
  residentIdleTimeoutMs: z.number().default(300000)
})

const ALL_TOOL_NAMES = [
  'status',
  'init',
  'sync',
  'explore',
  'context',
  'query',
  'node',
  'files',
  'callers',
  'callees',
  'impact',
  'affected',
  'uninit',
  'unlock',
  'daemon'
]

/** `init` is the bootstrap tool: autoInit is off by default, so an unindexed
 * project needs a way to build its index without editing plugin config. */
const ALWAYS_TOOL_NAMES = ['init']

function resolveToolSurface(raw) {
  const surface = new Set(ALWAYS_TOOL_NAMES)
  if (raw === 'all') {
    for (const name of ALL_TOOL_NAMES) surface.add(name)
    return surface
  }
  const entries = Array.isArray(raw) ? raw : String(raw).split(',')
  for (const entry of entries) {
    const name = String(entry).trim().replace(/^codegraph_/, '')
    if (name && ALL_TOOL_NAMES.includes(name)) surface.add(name)
  }
  return surface
}

// The system-prompt section is rendered from lib/guide.md; the tool inventory
// and the watcher paragraph follow the live configuration, so the text never
// advertises a tool that is not registered and never contradicts the surface.
let activeRoot = null

function guideText(surface, resident, autoInit, outputBudget) {
  let watch = activeRoot ? residentStatus(activeRoot) : null
  // activeRoot is the session cwd; residents are keyed by the index root. A
  // session inside an indexed project must still report that project's watcher.
  if (activeRoot && !watch?.running && !watch?.starting) {
    const probe = probeIndex(activeRoot)
    if (probe && probe.indexRoot !== activeRoot) watch = residentStatus(probe.indexRoot)
  }
  return renderGuide({ surface, resident, watch, autoInit, outputBudget })
}

/**
 * Report the watcher with a verified liveness verdict (P0-3).
 *
 * `running: true` only proves our launcher child is alive; the file watcher
 * lives in the detached daemon. Reading `.codegraph/daemon.pid` alone used to
 * produce "watch: active (daemon pid N)" for a pid that no longer existed, and
 * the model then trusted an index that was silently falling behind.
 */
export function formatWatch(watch, hasSync) {
  if (!watch) return 'watch: off'
  if (watch.configured === false) return 'watch: disabled'
  if (watch.state === 'fatal') {
    return 'watch: crashed — gave up after repeated failures (' + (watch.lastError || 'unknown error')
      + '); calls fall back to the CLI, '
      + (hasSync ? 'run codegraph_sync or reload the plugin to recover' : 'reload the plugin to recover')
  }
  if (watch.state === 'restarting' || watch.restartScheduled) {
    return 'watch: reconnecting (automatic restart scheduled'
      + (watch.lastError ? ' after: ' + watch.lastError : '') + ')'
  }
  if (watch.state === 'dead') {
    return 'watch: off — last start failed (' + (watch.lastError || 'unknown error') + '); retries on the next call'
  }
  if (watch.running) {
    if (watch.pidAlive === false && watch.pid != null) {
      return 'watch: STALE — daemon pid ' + (watch.pid ?? '?') + ' from .codegraph/daemon.pid is not running, so the index is NOT auto-syncing'
        + (hasSync ? '; run codegraph_sync before trusting recently changed source' : '; recently changed source may be stale')
    }
    if (watch.socketAlive === false && watch.pid != null) {
      return 'watch: unresponsive — daemon pid ' + (watch.pid ?? '?') + ' is alive but answered no handshake on its socket, so the index may be stale'
        + (hasSync ? '; run codegraph_sync' : '')
    }
    return 'watch: active' + (watch.pid ? ' (daemon pid ' + watch.pid + ')' : '')
      + (watch.restarts ? ', ' + watch.restarts + ' auto-restart' + (watch.restarts === 1 ? '' : 's') : '')
  }
  if (watch.starting) return 'watch: starting'
  return 'watch: off'
}

/**
 * Summarize an index status, surfacing what changes the next action (P0-2).
 *
 * The old version appended the whole status JSON after the summary — the same
 * numbers twice — while omitting `pendingChanges` and `reindexRecommended`, the
 * two fields that say "this index is behind, or was built by an older
 * extractor". Anomalies come first; the raw dump is opt-in.
 */
function formatStatus(info, watch, hasSync, options = {}) {
  const lines = [`initialized: ${info.initialized === true}`]
  if (info.version) lines.push(`version: ${info.version}`)
  if (info.projectPath) lines.push(`project: ${info.projectPath}`)
  if (info.fileCount !== undefined) lines.push(`files: ${info.fileCount}`)
  if (info.nodeCount !== undefined) lines.push(`nodes: ${info.nodeCount}`)
  if (info.edgeCount !== undefined) lines.push(`edges: ${info.edgeCount}`)
  if (info.dbSizeBytes !== undefined) lines.push(`db: ${(Number(info.dbSizeBytes) / 1024 / 1024).toFixed(1)} MB`)
  if (info.lastIndexed) lines.push(`lastIndexed: ${info.lastIndexed}`)
  if (info.index && typeof info.index === 'object' && info.index.state) lines.push(`index.state: ${info.index.state}`)
  if (info.initialized === true) lines.push(formatWatch(watch, hasSync))
  const anomalies = []
  const pending = info.pendingChanges
  if (pending && typeof pending === 'object') {
    const added = Number(pending.added) || 0
    const modified = Number(pending.modified) || 0
    const removed = Number(pending.removed) || 0
    const total = added + modified + removed
    if (total > 0) {
      anomalies.push(
        `pendingChanges: ${total} file(s) differ from the index (added ${added}, modified ${modified}, removed ${removed})` +
        (hasSync ? ' — run codegraph_sync, or wait for the watcher' : ' — the index is behind the working tree')
      )
    } else {
      lines.push('pendingChanges: none (index matches the working tree)')
    }
  }
  const index = info.index && typeof info.index === 'object' ? info.index : null
  if (index && index.reindexRecommended === true) {
    const built = index.builtWithExtractionVersion
    const current = index.currentExtractionVersion
    anomalies.push(
      'reindexRecommended: true' +
      (built !== undefined && current !== undefined ? ` — built with extraction v${built}, this CLI extracts v${current}` : '') +
      '; rebuild with codegraph_init { force: true } to pick up extractor improvements'
    )
  }
  if (index && Number(index.pendingRefs) > 0) {
    anomalies.push(`pendingRefs: ${index.pendingRefs} unresolved reference(s) in the graph`)
  }
  if (index && index.state && index.state !== 'complete') {
    anomalies.push(`index.state: ${index.state} — the last build did not finish; a rebuild may be needed`)
  }
  if (info.worktreeMismatch && typeof info.worktreeMismatch === 'object') {
    anomalies.push(
      `worktreeMismatch: the index belongs to ${info.worktreeMismatch.indexRoot} but the worktree is ${info.worktreeMismatch.worktreeRoot}` +
      ' — results describe the other tree'
    )
  }
  if (anomalies.length > 0) {
    lines.push('', '## Needs attention', ...anomalies.map((line) => '- ' + line))
  }
  if (options.json === true) lines.push('', JSON.stringify(info, null, 2))
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const {
    autoInit = false,
    maxAutoInitFiles = 5000,
    initTimeoutMs = 600000,
    queryTimeoutMs = 120000,
    syncTimeoutMs = 300000,
    maxFiles = 0,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    exploreMaxOutputChars = EXPLORE_MAX_OUTPUT_CHARS,
    exploreDedup = false,
    exploreDiagnostics = false,
    freshnessCheck = true,
    statusJson = false,
    contextMaxNodes = 20,
    contextIncludeCode = true,
    guideSearch = true,
    tools = ['explore'],
    resident = true,
    maxResidentProjects = 3,
    residentStartTimeoutMs = 30000,
    residentIdleTimeoutMs = 300000
  } = config

  const surface = resolveToolSurface(tools)

  configureResident({
    enabled: resident,
    maxProjects: maxResidentProjects,
    idleTimeoutMs: residentIdleTimeoutMs,
    mcpTools: surface.has('explore') ? ['explore'] : [],
    // Cross-call dedup is opt-in upstream: it only makes sense for a durable
    // single-connection context.
    env: exploreDedup ? { CODEGRAPH_EXPLORE_DEDUP: '1' } : {}
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      stopResidentSweeper()
      return stopAllResidents()
    }, 'dsh-codegraph-plugin: resident servers')
  }

  if (guideSearch !== false) {
    const registerGuide = () => ctx.systemPrompt.section({
      name: 'tool:dsh-codegraph-plugin',
      order: 98,
      // Recomputed each time the system prompt is assembled: the playbook is
      // rendered from lib/guide.md with the live tool surface and watcher
      // state, so a fatal watcher or an extended surface is reflected without
      // a reload.
      text: () => guideText(surface, resident, autoInit, { maxChars: maxOutputChars, exploreMaxChars: exploreMaxOutputChars }),
      // The rendered guide is literal text; DSH must not try to expand
      // {{...}} references inside it.
      interpolate: false
    })
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(registerGuide, 'dsh-codegraph-plugin: guidance')
      } else {
        registerGuide()
      }
    } catch {
      // A duplicate section name from another plugin is not fatal.
    }
  }

  async function rootFor(args, exec) {
    const workspace = await getWorkspaceRoot(ctx, exec)
    const root = typeof args.path === 'string' && args.path.trim().length > 0
      ? resolve(workspace, args.path.trim())
      : workspace
    assertOnDiskDirectory(root)
    // Remember the workspace the agent is actually working in: the system
    // prompt reports that project's watcher state on the next assembly.
    activeRoot = root
    return root
  }

  async function getStatus(root, exec) {
    const result = await runCodegraph(['status', '--json', root], {
      signal: exec.signal,
      timeoutMs: 30000
    })
    assertLaunched(result)
    if (result.code !== 0) throw new Error(formatOutcome(result))
    const text = result.stdout.trim()
    if (!text) throw new Error('codegraph status returned no output')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('codegraph status returned invalid JSON: ' + text.slice(0, 500))
    }
  }

  async function ensureReady(root, exec) {
    // Fast path: the index lives at a fixed path, and a filesystem probe costs
    // ~0 ms even for a multi-GB database, while `codegraph status --json`
    // opens and scans the whole DB just to report counts (1.4-1.6 s on the
    // 2.5 GB workspace index). Only pay for the CLI check when no index exists,
    // to explain why and to drive autoInit.
    const probe = probeIndex(root)
    if (probe) {
      return {
        initialized: true,
        projectPath: probe.indexRoot,
        indexPath: probe.dbPath,
        _probe: 'filesystem'
      }
    }

    const info = await getStatus(root, exec)
    if (info.initialized === true) return info

    if (!autoInit) {
      return { ...info, _autoInitReason: 'automatic initialization is disabled by default (autoInit: false)' }
    }
    if (!(await isProjectRoot(root))) {
      return { ...info, _autoInitReason: 'the workspace does not look like a project root (no .git/package.json/pyproject.toml/etc.)' }
    }
    if (maxAutoInitFiles > 0) {
      const count = await countFiles(root, maxAutoInitFiles)
      if (count > maxAutoInitFiles) {
        return { ...info, _autoInitReason: `the workspace has more than ${maxAutoInitFiles} files; run codegraph_init explicitly if intended` }
      }
    }

    const result = await runCodegraph(['init', '-y', root], {
      signal: exec.signal,
      timeoutMs: initTimeoutMs
    })
    assertLaunched(result)
    if (result.code !== 0) {
      return { ...info, _autoInitReason: 'automatic CodeGraph init failed: ' + formatOutcome(result) }
    }

    const after = await getStatus(root, exec)
    if (after.initialized === true) return after
    return { ...after, _autoInitReason: 'codegraph init finished but status still reports initialized: false' }
  }

  function notReadyMessage(root, info) {
    const reason = info._autoInitReason ? ' ' + info._autoInitReason + '.' : ''
    return `CodeGraph is not initialized for ${root}.${reason}\nRun codegraph_init (or pass a path to an already indexed project) and retry.`
  }

  /** Resident servers are keyed by the index root, not by the session cwd, so
   * two sessions inside one indexed project share a single watcher. */
  function residentRootOf(info, root) {
    return typeof info?.projectPath === 'string' && info.projectPath ? info.projectPath : root
  }

  function startResident(root) {
    warmResident(root, { startTimeoutMs: residentStartTimeoutMs })
  }

  async function awaitResident(root) {
    try {
      return await ensureResident(root, { startTimeoutMs: residentStartTimeoutMs })
    } catch {
      return null
    }
  }

  /**
   * Watcher status with a verified daemon verdict.
   *
   * Waits briefly for the handshake to publish a pidfile, then confirms the
   * pid is alive and the daemon pipe answers (P0-3). A pidfile alone cannot
   * distinguish "watching" from "crashed hours ago".
   */
  async function watchedStatus(root, timeoutMs = 900) {
    let status = residentStatus(root)
    const deadline = Date.now() + timeoutMs
    while (status.running && !status.pid && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100))
      status = residentStatus(root)
    }
    return verifyResident(root)
  }

  function registerTool(toolName, description, parameters, buildArgv, opts = {}) {
    const tool = defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }]
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.()
        try {
          return await buildArgv(args, exec)
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          // Expected conditions (not indexed, path not on disk) become a normal
          // result with guidance. Real faults — missing binary, failed spawn,
          // timeout, crash — must surface as a tool error: disguising them as
          // successful output is what made the model abandon the tool after a
          // single failed call.
          if (error?.expected === true) return error.message
          throw error
        }
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: 'codegraph ' + toolName.replace(/^codegraph_/, ''),
        description: opts.callDescription
      })
    })
    ctx.tools.register(tool)
  }

  if (surface.has('status')) {
    registerTool(
      'codegraph_status',
      'Show the CodeGraph index status for a project (initialized, version, projectPath, lastIndexed, fileCount, nodeCount, pendingChanges, languages) plus the resident file watcher state. Needs-attention items (pendingChanges, reindexRecommended, worktreeMismatch, unfinished index) are surfaced first. Run this first to check whether a project is indexed.',
      {
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
        json: { type: 'boolean', description: 'Also dump the raw status JSON (default: false; the summary already covers every field that matters).' }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await getStatus(root, exec)
        const key = residentRootOf(info, root)
        if (info.initialized === true) await awaitResident(key)
        return formatStatus(info, await watchedStatus(key), surface.has('sync'), { json: args.json === true || statusJson === true })
      },
      { callDescription: 'Show CodeGraph index status' }
    )
  }

  // Always registered: the bootstrap tool for unindexed projects.
  registerTool(
    'codegraph_init',
    'Initialize CodeGraph in a project directory and build the initial index (creates a .codegraph/ directory). Non-interactive. Use force: true to rebuild an already indexed project.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      force: { type: 'boolean', description: 'Force a full rebuild even if the project is already initialized.' }
    },
    async (args, exec) => {
      const root = await rootFor(args, exec)
      const info = await getStatus(root, exec)
      if (info.initialized === true && args.force !== true) {
        const key = residentRootOf(info, root)
        startResident(key)
        return `CodeGraph is already initialized for ${root}. Use force: true to rebuild the index.\n\n` + formatStatus(info, residentStatus(key), surface.has('sync'))
      }

      let result
      if (info.initialized === true && args.force === true) {
        // init --force only allows home/root paths to be initialized; the real
        // rebuild command is `codegraph index`. Stop our resident proxy first so
        // CodeGraph can stop the daemon, then rebuild and restart the watcher.
        await stopResident(residentRootOf(info, root))
        result = await runCodegraph(['index', '--force', root], {
          cwd: root,
          signal: exec.signal,
          timeoutMs: initTimeoutMs
        })
      } else {
        result = await runCodegraph(['init', '-y', ...(args.force ? ['--force'] : []), root], {
          signal: exec.signal,
          timeoutMs: initTimeoutMs
        })
      }
      assertLaunched(result)

      const after = await getStatus(root, exec).catch(() => null)
      const key = residentRootOf(after, root)
      if (after?.initialized === true) await awaitResident(key)
      return formatOutcome(result) + (after ? '\n\n' + formatStatus(after, residentStatus(key), surface.has('sync')) : '')
    },
    { timeoutMs: initTimeoutMs, callDescription: 'Initialize the CodeGraph index' }
  )

  if (surface.has('sync')) {
    registerTool(
      'codegraph_sync',
      resident
        ? 'Incrementally sync the CodeGraph index with changes since the last index. The resident watcher normally syncs automatically; use this as a manual fallback after editing files.'
        : 'Incrementally sync the CodeGraph index with changes since the last index. This session has no resident watcher, so run it after editing files to refresh the index.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await getStatus(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)
        const result = await runCodegraph(['sync', root], {
          signal: exec.signal,
          timeoutMs: syncTimeoutMs
        })
        assertLaunched(result)
        // A resident that gave up (fatal) gets a fresh server after a
        // successful sync — the user's explicit retry should actually heal it.
        const key = residentRootOf(info, root)
        if (residentStatus(key).state === 'fatal') await stopResident(key)
        startResident(key)
        return formatOutcome(result)
      },
      { timeoutMs: syncTimeoutMs, callDescription: 'Sync the CodeGraph index' }
    )
  }

  const queryTimeout = autoInit ? initTimeoutMs + queryTimeoutMs : queryTimeoutMs

  // File counts drive the official output budget tiers. A recursive walk costs
  // ~200 ms on a 3k-file workspace; cache it for five minutes so every explore
  // call does not pay it again.
  const fileCountCache = new Map()
  const FILE_COUNT_TTL_MS = 5 * 60 * 1000

  async function countFilesCached(root) {
    const now = Date.now()
    const hit = fileCountCache.get(root)
    if (hit && now - hit.at < FILE_COUNT_TTL_MS) return hit.count
    const count = await countFiles(root, 5000)
    fileCountCache.set(root, { count, at: now })
    return count
  }

  function queryTool(surfaceKey, toolName, description, parameters, buildArgs, opts = {}) {
    if (!surface.has(surfaceKey)) return
    registerTool(
      toolName,
      description,
      parameters,
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await ensureReady(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)
        if (resident && surface.has('explore')) startResident(residentRootOf(info, root))
        const result = await runCodegraph(buildArgs(args, root), {
          signal: exec.signal,
          timeoutMs: opts.timeoutMs ?? queryTimeout
        })
        assertLaunched(result)
        // P1-9: the CLI sometimes exits 0 with `[]` for "nothing matched" (data)
        // and exits non-zero for real failures. Do not let a non-zero exit ride
        // along as ordinary output where the model can mistake it for a result.
        if (result.code !== 0) throw new Error(formatOutcome(result, { maxChars: maxOutputChars }))
        return formatOutcome(result, { maxChars: maxOutputChars })
      },
      { timeoutMs: opts.timeoutMs ?? queryTimeout, callDescription: opts.callDescription }
    )
  }

  if (surface.has('explore')) {
    registerTool(
      'codegraph_explore',
      exploreDescription(surface, resident, autoInit),
      {
        query: { type: 'string', required: true, description: 'Natural-language area description, e.g. "payment checkout flow".' },
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
        maxFiles: { type: 'integer', description: 'Maximum number of files to include source from (default: scaled to the workspace size: 4 under 150 files, 5 under 500, 8 above).' },
        diagnostics: { type: 'boolean', description: 'Append a per-file answer budget report (chars emitted, share of the answer, files skipped) to help diagnose wrong file selection.' }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await ensureReady(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)

        const key = residentRootOf(info, root)
        const fileCount = await countFilesCached(key).catch(() => 0)
        const budget = exploreOutputBudget(fileCount)
        const effectiveMaxFiles = args.maxFiles || maxFiles || budget.defaultMaxFiles
        const hardCeiling = Math.min(hardCeilingFor(budget), exploreMaxOutputChars)
        const calls = exploreCallBudget(fileCount)

        const finalize = (text) => {
          let out = text.trim()
          if (!out) return out
          const indexedAt = indexTimestamp(key)
          if (freshnessCheck && indexedAt > 0) {
            const files = extractExploreFiles(out)
            if (files.length > 0) {
              const stale = staleFilesSince(key, files, indexedAt)
              const warning = freshnessWarning(stale.stale, indexedAt)
              if (warning) out = warning + '\n\n' + out
            }
          }
          if (args.diagnostics === true || exploreDiagnostics === true) {
            out += '\n\n' + buildExploreDiagnostics(out, { fileCount, budget, maxFiles: effectiveMaxFiles })
          }
          if (out.length > hardCeiling) out = truncateMiddle(out, hardCeiling, 'codegraph explore')
          // The official budget guidance: one explore call covers a focused area;
          // larger indexes may need more calls rather than a bigger single answer.
          if (calls > 1 && out.length > hardCeiling * 0.9) {
            out += `\n\n[budget] This workspace is large (${fileCount} files): prefer ${calls} focused explore calls over one broad query.`
          }
          return out
        }

        const server = await awaitResident(key)
        if (server) {
          try {
            const text = await server.callTool(
              'codegraph_explore',
              {
                query: args.query,
                maxFiles: effectiveMaxFiles,
                projectPath: key
              },
              { signal: exec.signal, timeoutMs: queryTimeout }
            )
            if (text && text.trim()) return finalize(text)
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            // Fall back to the CLI if the resident server is unhealthy.
          }
        }

        const result = await runCodegraph(
          ['explore', '--path', root, '--max-files', String(effectiveMaxFiles), args.query],
          {
            signal: exec.signal,
            timeoutMs: queryTimeout,
            env: exploreDedup ? { CODEGRAPH_EXPLORE_DEDUP: '1' } : undefined
          }
        )
        const formatted = formatOutcome(assertLaunched(result), { maxChars: hardCeiling })
        return finalize(formatted)
      },
      { timeoutMs: queryTimeout, callDescription: 'Explore a code area with source + call paths' }
    )
  }

  queryTool(
    'query',
    'codegraph_query',
    'Search symbols in the codebase by name and return matching nodes as JSON (kind, name, filePath, startLine, score). Requires an initialized project.',
    {
      search: { type: 'string', required: true, description: 'Symbol name or partial name to search for (e.g. "multiply").' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 10).' },
      kind: { type: 'string', description: 'Filter by node kind (function, class, interface, import, file, ...).' }
    },
    (args, root) => ['query', '--json', '--path', root, '-l', String(args.limit || 10)]
      .concat(args.kind ? ['-k', args.kind] : [])
      .concat([args.search]),
    { callDescription: 'Search symbols in the codebase' }
  )

  queryTool(
    'node',
    'codegraph_node',
    "Get one symbol's source with its caller/callee trail, or read a file with line numbers and its dependents. Pass a symbol name for symbol mode; pass a file path (or set file: true) for file mode.",
    {
      name: { type: 'string', required: true, description: 'A symbol name (e.g. multiply) or a file path (e.g. src/math.ts).' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      file: { type: 'boolean', description: 'Treat the name as a file path (disambiguate a symbol to this file).' },
      offset: { type: 'integer', description: 'File mode: 1-based start line.' },
      limit: { type: 'integer', description: 'File mode: maximum lines.' },
      symbolsOnly: { type: 'boolean', description: 'File mode: only the symbol map + dependents, no source.' }
    },
    (args, root) => {
      const argv = ['node', '--path', root]
      if (args.file) {
        argv.push('--file', args.name)
      } else {
        argv.push(args.name)
      }
      if (args.offset) argv.push('--offset', String(args.offset))
      if (args.limit) argv.push('--limit', String(args.limit))
      if (args.symbolsOnly) argv.push('--symbols-only')
      return argv
    },
    { timeoutMs: 60000, callDescription: 'Show a symbol or file with its trail' }
  )

  queryTool(
    'files',
    'codegraph_files',
    'Show the project file structure from the index as JSON (paths, languages, symbol counts). Supports directory/glob filters and tree/flat/grouped formats.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      filter: { type: 'string', description: 'Only files under this directory.' },
      pattern: { type: 'string', description: 'Only files matching this glob (e.g. "src/**/*.ts").' },
      format: { type: 'string', description: 'Output format: tree, flat, or grouped.' },
      maxDepth: { type: 'integer', description: 'Maximum directory depth for the tree format.' },
      noMetadata: { type: 'boolean', description: 'Hide file metadata (language, symbol count).' }
    },
    (args, root) => {
      const argv = ['files', '--json', '--path', root]
      if (args.filter) argv.push('--filter', args.filter)
      if (args.pattern) argv.push('--pattern', args.pattern)
      if (args.format) argv.push('--format', args.format)
      if (args.maxDepth) argv.push('--max-depth', String(args.maxDepth))
      if (args.noMetadata) argv.push('--no-metadata')
      return argv
    },
    { callDescription: 'Show the indexed file structure' }
  )

  queryTool(
    'callers',
    'codegraph_callers',
    'Find all functions/methods that call a specific symbol. Returns JSON callers with name, kind, filePath, startLine.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to find callers for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 20).' }
    },
    (args, root) => ['callers', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
    { callDescription: 'Find callers of a symbol' }
  )

  queryTool(
    'callees',
    'codegraph_callees',
    'Find all functions/methods that a specific symbol calls. Returns JSON callees with name, kind, filePath, startLine.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to find callees for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 20).' }
    },
    (args, root) => ['callees', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
    { callDescription: 'Find callees of a symbol' }
  )

  queryTool(
    'impact',
    'codegraph_impact',
    'Analyze what code is affected by changing a symbol (traverses callers up to a depth). Use before refactoring or renaming.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to analyze impact for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      depth: { type: 'integer', description: 'Traversal depth (default 2).' }
    },
    (args, root) => ['impact', '--json', '--path', root, '-d', String(args.depth || 2), args.symbol],
    { callDescription: 'Analyze impact of changing a symbol' }
  )

  queryTool(
    'affected',
    'codegraph_affected',
    'Find test files affected by changed source files. Pass one or more changed source paths relative to the project root.',
    {
      files: {
        type: 'array',
        required: true,
        description: 'Changed source file paths (relative to the project root), e.g. ["src/math.ts"].',
        items: { type: 'string' }
      },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      depth: { type: 'integer', description: 'Max dependency traversal depth (default 5).' },
      filter: { type: 'string', description: 'Custom glob filter for test files (e.g. "e2e/*.spec.ts").' }
    },
    (args, root) => ['affected', '--json', '--path', root, '-d', String(args.depth || 5)]
      .concat(args.filter ? ['--filter', args.filter] : [])
      .concat(args.files),
    { callDescription: 'Find affected test files' }
  )

  if (surface.has('context')) {
    registerTool(
      'codegraph_context',
      'Assemble task-focused context for a change or question: entry points, related symbols and (optionally) their source. This is the official `codegraph context` builder — it starts from a task description instead of a search query, so it fits "I need to do X" better than codegraph_explore.',
      {
        task: { type: 'string', required: true, description: 'The task or question to assemble context for, e.g. "fix login bug".' },
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
        format: { type: 'string', description: 'markdown (default) or json.' },
        maxNodes: { type: 'integer', description: `Maximum nodes to include (default ${contextMaxNodes}).` },
        includeCode: { type: 'boolean', description: `Include verbatim source blocks (default ${contextIncludeCode}).` }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await ensureReady(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)
        const argv = [
          'context',
          '--path', root,
          '--format', args.format === 'json' ? 'json' : 'markdown',
          '--max-nodes', String(args.maxNodes || contextMaxNodes)
        ]
        const includeCode = args.includeCode === undefined ? contextIncludeCode : args.includeCode === true
        if (!includeCode) argv.push('--no-code')
        argv.push(args.task)
        const result = await runCodegraph(argv, {
          signal: exec.signal,
          timeoutMs: queryTimeout
        })
        return formatOutcome(assertLaunched(result), { maxChars: maxOutputChars })
      },
      { timeoutMs: queryTimeout, callDescription: 'Assemble task-focused context' }
    )
  }

  if (surface.has('uninit')) {
    registerTool(
      'codegraph_uninit',
      'Delete a project\'s .codegraph/ directory and remove CodeGraph git hooks. Destructive: requires force: true. The official CLI prompts on a TTY and silently does nothing without --force, so this tool refuses unless force is explicit.',
      {
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
        force: { type: 'boolean', description: 'Must be true to actually delete the index.' }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        if (args.force !== true) {
          return `Refusing to uninitialize ${root}: this permanently deletes .codegraph/. Pass force: true to confirm.`
        }
        const info = await getStatus(root, exec).catch(() => null)
        if (info && info.initialized === true) {
          const key = residentRootOf(info, root)
          await stopResident(key)
          fileCountCache.delete(key)
        }
        const result = await runCodegraph(['uninit', '--force', root], {
          signal: exec.signal,
          timeoutMs: syncTimeoutMs
        })
        return formatOutcome(assertLaunched(result))
      },
      { timeoutMs: syncTimeoutMs, callDescription: 'Delete the CodeGraph index' }
    )
  }

  if (surface.has('unlock')) {
    registerTool(
      'codegraph_unlock',
      'Remove stale CodeGraph lock files and daemon artifacts for a project that reports the index is locked. Safe: only lock files are deleted.',
      {
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const result = await runCodegraph(['unlock', root], {
          signal: exec.signal,
          timeoutMs: syncTimeoutMs
        })
        return formatOutcome(assertLaunched(result))
      },
      { timeoutMs: syncTimeoutMs, callDescription: 'Clear stale CodeGraph locks' }
    )
  }

  if (surface.has('daemon')) {
    registerTool(
      'codegraph_daemon',
      'List CodeGraph daemons with verified liveness (pid exists and its socket answers), or stop the daemon for one project. The official daemon command is an interactive picker; this tool is non-interactive.',
      {
        action: { type: 'string', description: 'list (default) or stop.' },
        path: { type: 'string', description: 'Project directory for action "stop" (default: the current session workspace).' }
      },
      async (args, exec) => {
        const action = args.action === 'stop' ? 'stop' : 'list'
        if (action === 'stop') {
          const root = await rootFor(args, exec)
          const info = await getStatus(root, exec).catch(() => null)
          const key = info && info.initialized === true ? residentRootOf(info, root) : root
          await stopResident(key)
          const stopped = await stopDaemon(key)
          return stopped && stopped.stopped
            ? `Stopped the CodeGraph daemon for ${key} (pid ${stopped.pid}).`
            : `No live CodeGraph daemon found for ${key}${stopped && stopped.reason ? ' (' + stopped.reason + ')' : ''}.`
        }
        const records = await verifiedDaemons()
        const live = records.filter((record) => record.alive)
        if (live.length === 0) return 'No live CodeGraph daemons found (stale registry entries ignored).'
        return live.map((record) => {
          const version = record.version ? ` v${record.version}` : ''
          const started = record.startedAt ? ` (started ${new Date(record.startedAt).toISOString()})` : ''
          return `pid ${record.pid}${version}${started} ${record.root || ''}`.trim()
        }).join('\n')
      },
      { callDescription: 'Manage CodeGraph daemons' }
    )
  }
}
