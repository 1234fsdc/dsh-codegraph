// dsh-codegraph-plugin — native DSH tools around the bundled CodeGraph CLI.

import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { formatOutcome, runCodegraph } from './cli.js'
import { countFiles, getWorkspaceRoot, isProjectRoot } from './workspace.js'

export const name = 'dsh-codegraph-plugin'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

export const Config = z.object({
  // Automatically initialize CodeGraph for a plausible project on first use.
  autoInit: z.boolean().default(true),
  maxAutoInitFiles: z.number().default(5000),
  initTimeoutMs: z.number().default(600000),
  queryTimeoutMs: z.number().default(120000),
  syncTimeoutMs: z.number().default(300000),
  maxFiles: z.number().default(8),
  guideSearch: z.boolean().default(true)
})

const CODEGRAPH_GUIDE = `# CodeGraph — indexed code knowledge graph

CodeGraph maintains a pre-indexed graph of symbols and call edges for the current project.
- Start with codegraph_status. When it reports initialized: true, prefer codegraph_explore to locate or understand code — one call returns the relevant symbols' source with call paths, often replacing several grep/glob/read calls. After editing source files, run codegraph_sync so later calls reflect the new code.
- When the project is not initialized, codegraph_explore can initialize it automatically when the workspace looks like a project; codegraph_init is available when you need an explicit full rebuild.
- The tools read from the index. When a query returns nothing useful, fall back to grep/glob/read instead of retrying.`

function formatStatus(info) {
  const lines = [`initialized: ${info.initialized === true}`]
  if (info.version) lines.push(`version: ${info.version}`)
  if (info.projectPath) lines.push(`project: ${info.projectPath}`)
  if (info.fileCount !== undefined) lines.push(`files: ${info.fileCount}`)
  if (info.nodeCount !== undefined) lines.push(`nodes: ${info.nodeCount}`)
  if (info.edgeCount !== undefined) lines.push(`edges: ${info.edgeCount}`)
  if (info.dbSizeBytes !== undefined) lines.push(`db: ${(Number(info.dbSizeBytes) / 1024 / 1024).toFixed(1)} MB`)
  if (info.lastIndexed) lines.push(`lastIndexed: ${info.lastIndexed}`)
  if (info.index && typeof info.index === 'object' && info.index.state) lines.push(`index.state: ${info.index.state}`)
  return lines.join('\n') + '\n\n' + JSON.stringify(info, null, 2)
}

export function apply(ctx, config = {}) {
  const {
    autoInit = true,
    maxAutoInitFiles = 5000,
    initTimeoutMs = 600000,
    queryTimeoutMs = 120000,
    syncTimeoutMs = 300000,
    maxFiles = 8,
    guideSearch = true
  } = config

  if (guideSearch !== false) {
    const registerGuide = () => ctx.systemPrompt.section({
      name: 'tool:dsh-codegraph-plugin',
      order: 98,
      text: CODEGRAPH_GUIDE
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
    if (typeof args.path === 'string' && args.path.trim().length > 0) {
      return resolve(workspace, args.path.trim())
    }
    return workspace
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
    const info = await getStatus(root, exec)
    if (info.initialized === true) return info

    if (!autoInit) {
      return { ...info, _autoInitReason: 'automatic initialization is disabled (autoInit: false)' }
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

  registerTool(
    'codegraph_status',
    'Show the CodeGraph index status for a project as JSON (initialized, version, projectPath, lastIndexed, fileCount, nodeCount, pendingChanges, languages). Run this first to check whether a project is indexed.',
    { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
    async (args, exec) => {
      const root = await rootFor(args, exec)
      return formatStatus(await getStatus(root, exec))
    },
    { callDescription: 'Show CodeGraph index status' }
  )

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
        return `CodeGraph is already initialized for ${root}. Use force: true to rebuild the index.\n\n` + formatStatus(info)
      }
      const result = await runCodegraph(['init', '-y', ...(args.force ? ['--force'] : []), root], {
        cwd: root,
        signal: exec.signal,
        timeoutMs: initTimeoutMs
      })
      const after = await getStatus(root, exec).catch(() => null)
      return formatOutcome(result) + (after ? '\n\n' + formatStatus(after) : '')
    },
    { timeoutMs: initTimeoutMs, callDescription: 'Initialize the CodeGraph index' }
  )

  registerTool(
    'codegraph_sync',
    'Incrementally sync the CodeGraph index with changes since the last index. Run after editing files so later queries reflect the new code.',
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
      return formatOutcome(result)
    },
    { timeoutMs: syncTimeoutMs, callDescription: 'Sync the CodeGraph index' }
  )

  const queryTimeout = autoInit ? initTimeoutMs + queryTimeoutMs : queryTimeoutMs

  async function queryTool(toolName, description, parameters, buildArgs, opts = {}) {
    registerTool(
      toolName,
      description,
      parameters,
      async (args, exec) => {
        const root = await rootFor(args, exec)
        const info = await ensureReady(root, exec)
        if (info.initialized !== true) return notReadyMessage(root, info)
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

  queryTool(
    'codegraph_explore',
    'Explore an area of the codebase: relevant symbols\' verbatim source plus call paths in one shot. Give a natural-language description of the area (e.g. "user authentication flow"). Requires an initialized project; initializes automatically when possible.',
    {
      query: { type: 'string', required: true, description: 'Natural-language area description, e.g. "payment checkout flow".' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      maxFiles: { type: 'integer', description: 'Maximum number of files to include source from (default: plugin maxFiles).' }
    },
    (args, root) => ['explore', '--path', root]
      .concat(['--max-files', String(args.maxFiles || maxFiles)])
      .concat([args.query]),
    { callDescription: 'Explore a code area with source + call paths' }
  )

  queryTool(
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
