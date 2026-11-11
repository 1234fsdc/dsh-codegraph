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
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { formatOutcome, runCodegraph } from './cli.js'
import { probeIndex } from './readiness.js'
import { countFiles, getWorkspaceRoot, isProjectRoot } from './workspace.js'
import {
  configureResident,
  ensureResident,
  residentStatus,
  stopAllResidents,
  stopResident,
  warmResident
} from './resident.js'
import { renderGuide, exploreDescription } from './guide.js'

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
  maxFiles: z.number().default(8),
  guideSearch: z.boolean().default(true),
  // Which tools are listed to the agent. Defaults to the official surface:
  // only `explore` (plus the always-on `init` bootstrap). Accepts "all", a
  // comma-separated string, or a list of short names, e.g. ["explore", "query"].
  tools: z.union([z.string(), z.array(z.string())]).default(['explore']),
  // Keep a resident CodeGraph MCP server (daemon + file watcher) per workspace.
  resident: z.boolean().default(true),
  maxResidentProjects: z.number().default(3),
  residentStartTimeoutMs: z.number().default(30000)
})

const ALL_TOOL_NAMES = [
  'status',
  'init',
  'sync',
  'explore',
  'query',
  'node',
  'files',
  'callers',
  'callees',
  'impact',
  'affected'
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

function guideText(surface, resident) {
  const watch = activeRoot ? residentStatus(activeRoot) : null
  return renderGuide({ surface, resident, watch })
}

function formatWatch(watch) {
  if (!watch) return 'watch: off'
  if (watch.configured === false) return 'watch: disabled'
  if (watch.state === 'fatal') {
    return 'watch: crashed — gave up after repeated failures (' + (watch.lastError || 'unknown error')
      + '); calls fall back to the CLI, run codegraph_sync or reload the plugin to recover'
  }
  if (watch.state === 'restarting' || watch.restartScheduled) {
    return 'watch: reconnecting (automatic restart scheduled'
      + (watch.lastError ? ' after: ' + watch.lastError : '') + ')'
  }
  if (watch.state === 'dead') {
    return 'watch: off — last start failed (' + (watch.lastError || 'unknown error') + '); retries on the next call'
  }
  if (watch.running) {
    return 'watch: active' + (watch.pid ? ' (daemon pid ' + watch.pid + ')' : '')
      + (watch.restarts ? ', ' + watch.restarts + ' auto-restart' + (watch.restarts === 1 ? '' : 's') : '')
  }
  if (watch.starting) return 'watch: starting'
  return 'watch: off'
}

function formatStatus(info, watch) {
  const lines = [`initialized: ${info.initialized === true}`]
  if (info.version) lines.push(`version: ${info.version}`)
  if (info.projectPath) lines.push(`project: ${info.projectPath}`)
  if (info.fileCount !== undefined) lines.push(`files: ${info.fileCount}`)
  if (info.nodeCount !== undefined) lines.push(`nodes: ${info.nodeCount}`)
  if (info.edgeCount !== undefined) lines.push(`edges: ${info.edgeCount}`)
  if (info.dbSizeBytes !== undefined) lines.push(`db: ${(Number(info.dbSizeBytes) / 1024 / 1024).toFixed(1)} MB`)
  if (info.lastIndexed) lines.push(`lastIndexed: ${info.lastIndexed}`)
  if (info.index && typeof info.index === 'object' && info.index.state) lines.push(`index.state: ${info.index.state}`)
  if (info.initialized === true) lines.push(formatWatch(watch))
  return lines.join('\n') + '\n\n' + JSON.stringify(info, null, 2)
}

export function apply(ctx, config = {}) {
  const {
    autoInit = false,
    maxAutoInitFiles = 5000,
    initTimeoutMs = 600000,
    queryTimeoutMs = 120000,
    syncTimeoutMs = 300000,
    maxFiles = 8,
    guideSearch = true,
    tools = ['explore'],
    resident = true,
    maxResidentProjects = 3,
    residentStartTimeoutMs = 30000
  } = config

  const surface = resolveToolSurface(tools)

  configureResident({
    enabled: resident,
    maxProjects: maxResidentProjects,
    mcpTools: surface.has('explore') ? ['explore'] : []
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stopAllResidents(), 'dsh-codegraph-plugin: resident servers')
  }

  if (guideSearch !== false) {
    const registerGuide = () => ctx.systemPrompt.section({
      name: 'tool:dsh-codegraph-plugin',
      order: 98,
      // Recomputed each time the system prompt is assembled: the playbook is
      // rendered from lib/guide.md with the live tool surface and watcher
      // state, so a fatal watcher or an extended surface is reflected without
      // a reload.
      text: () => guideText(surface, resident),
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
    // Remember the workspace the agent is actually working in: the system
    // prompt reports that project's watcher state on the next assembly.
    activeRoot = root
    return root
  }

  async function getStatus(root, exec) {
    const result = await runCodegraph(['status', '--json', root], {
      cwd: root,
      signal: exec.signal,
      timeoutMs: 30000
    })
    if (result.error) throw result.error
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
      cwd: root,
      signal: exec.signal,
      timeoutMs: initTimeoutMs
    })
    if (result.error) throw result.error
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

  async function watchedStatus(root, timeoutMs = 900) {
    let status = residentStatus(root)
    const deadline = Date.now() + timeoutMs
    while (status.running && !status.pid && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100))
      status = residentStatus(root)
    }
    return status
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
          return 'codegraph: ' + error.message
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
      'Show the CodeGraph index status for a project as JSON (initialized, version, projectPath, lastIndexed, fileCount, nodeCount, pendingChanges, languages) plus the resident file watcher state. Run this first to check whether a project is indexed.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await getStatus(root, exec)
        if (info.initialized === true) await awaitResident(root)
        return formatStatus(info, await watchedStatus(root))
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
        startResident(root)
        return `CodeGraph is already initialized for ${root}. Use force: true to rebuild the index.\n\n` + formatStatus(info, residentStatus(root))
      }

      let result
      if (info.initialized === true && args.force === true) {
        // init --force only allows home/root paths to be initialized; the real
        // rebuild command is `codegraph index`. Stop our resident proxy first so
        // CodeGraph can stop the daemon, then rebuild and restart the watcher.
        await stopResident(root)
        result = await runCodegraph(['index', '--force', root], {
          cwd: root,
          signal: exec.signal,
          timeoutMs: initTimeoutMs
        })
      } else {
        result = await runCodegraph(['init', '-y', ...(args.force ? ['--force'] : []), root], {
          cwd: root,
          signal: exec.signal,
          timeoutMs: initTimeoutMs
        })
      }

      const after = await getStatus(root, exec).catch(() => null)
      if (after?.initialized === true) await awaitResident(root)
      return formatOutcome(result) + (after ? '\n\n' + formatStatus(after, residentStatus(root)) : '')
    },
    { timeoutMs: initTimeoutMs, callDescription: 'Initialize the CodeGraph index' }
  )

  if (surface.has('sync')) {
    registerTool(
      'codegraph_sync',
      'Incrementally sync the CodeGraph index with changes since the last index. The resident watcher normally syncs automatically; use this as a manual fallback after editing files.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await getStatus(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)
        const result = await runCodegraph(['sync', root], {
          cwd: root,
          signal: exec.signal,
          timeoutMs: syncTimeoutMs
        })
        // A resident that gave up (fatal) gets a fresh server after a
        // successful sync — the user's explicit retry should actually heal it.
        if (residentStatus(root).state === 'fatal') await stopResident(root)
        startResident(root)
        return formatOutcome(result)
      },
      { timeoutMs: syncTimeoutMs, callDescription: 'Sync the CodeGraph index' }
    )
  }

  const queryTimeout = autoInit ? initTimeoutMs + queryTimeoutMs : queryTimeoutMs

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
        startResident(root)
        const result = await runCodegraph(buildArgs(args, root), {
          cwd: root,
          signal: exec.signal,
          timeoutMs: opts.timeoutMs ?? queryTimeout
        })
        return formatOutcome(result)
      },
      { timeoutMs: opts.timeoutMs ?? queryTimeout, callDescription: opts.callDescription }
    )
  }

  if (surface.has('explore')) {
    registerTool(
      'codegraph_explore',
      exploreDescription(surface, resident),
      {
        query: { type: 'string', required: true, description: 'Natural-language area description, e.g. "payment checkout flow".' },
        path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
        maxFiles: { type: 'integer', description: 'Maximum number of files to include source from (default: plugin maxFiles).' }
      },
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await ensureReady(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)

        const server = await awaitResident(root)
        if (server) {
          try {
            const text = await server.callTool(
              'codegraph_explore',
              {
                query: args.query,
                maxFiles: args.maxFiles || maxFiles,
                projectPath: root
              },
              { signal: exec.signal, timeoutMs: queryTimeout }
            )
            if (text && text.trim()) return text.trim()
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            // Fall back to the CLI if the resident server is unhealthy.
          }
        }

        const result = await runCodegraph(
          ['explore', '--path', root, '--max-files', String(args.maxFiles || maxFiles), args.query],
          { cwd: root, signal: exec.signal, timeoutMs: queryTimeout }
        )
        return formatOutcome(result)
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
}
