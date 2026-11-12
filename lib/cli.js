// Resolve and run the CodeGraph CLI bundled with this plugin.
//
// @colbymchenry/codegraph deliberately exposes only "." and "./package.json"
// in its package exports, so the npm-shim entry cannot be resolved directly.
// Resolve package.json first, then join npm-shim.js next to it.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { scrubChildEnvironment } from './env.js'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  annotateEmpty,
  compactJsonForCommand,
  truncateMiddle
} from './budget.js'

const require = createRequire(import.meta.url)
const MAX_STDOUT_CHARS = 8 * 1024 * 1024
const MAX_STDERR_CHARS = 2 * 1024 * 1024

let cachedShimPath
let cachedCommand
let cachedSpawnCwd

/**
 * The working directory for CodeGraph child processes.
 *
 * It must never be the project root. `spawn` validates `cwd` before the
 * binary runs, so a virtual path (`...\app.asar\dsh`), a directory that does
 * not exist yet, or a mistyped path fails with ENOENT and no CodeGraph output
 * at all — which is exactly how the first real `codegraph_explore` call in a
 * DSH session died (the model passed the app.asar checkout path). Every command
 * carries its project explicitly (`--path <root>` or a positional root), so the
 * working directory has no semantic value: use a private temp directory that is
 * guaranteed to exist and be writable.
 *
 * @returns {string}
 */
export function resolveSpawnCwd() {
  if (cachedSpawnCwd) return cachedSpawnCwd
  const dir = join(tmpdir(), 'dsh-codegraph-plugin')
  try {
    mkdirSync(dir, { recursive: true })
    cachedSpawnCwd = dir
  } catch {
    cachedSpawnCwd = tmpdir()
  }
  return cachedSpawnCwd
}

export function resolveCodegraphShim() {
  if (cachedShimPath) return cachedShimPath

  const candidates = []
  const override = process.env.DSH_CODEGRAPH_PACKAGE_ROOT
  if (override) candidates.push(join(override, 'npm-shim.js'))

  try {
    const manifest = require.resolve('@colbymchenry/codegraph/package.json')
    candidates.push(join(dirname(manifest), 'npm-shim.js'))
  } catch {
    // fall through to a helpful error below
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedShimPath = candidate
      return candidate
    }
  }

  const error = new Error(
    'CodeGraph CLI not found. dsh-codegraph-plugin should install ' +
      '@colbymchenry/codegraph as a dependency; reinstall the plugin and retry. ' +
      'For development only, set DSH_CODEGRAPH_PACKAGE_ROOT to the package directory.'
  )
  error.code = 'CODEGRAPH_CLI_NOT_FOUND'
  throw error
}

/**
 * Resolve the CodeGraph launcher. On Windows the npm shim runs the platform
 * bundle through spawnSync, so an aborted shim can leave the real CodeGraph
 * process alive. Prefer launching the bundled platform node.exe directly so
 * the host's abort signal reaches the process we actually own. Fall back to
 * the npm shim when the platform package is unavailable.
 *
 * @returns {{command: string, args: string[]}}
 */
export function resolveCodegraphCommand() {
  if (cachedCommand) return cachedCommand

  if (!process.env.DSH_CODEGRAPH_PACKAGE_ROOT) {
    const target = process.platform + '-' + process.arch
    const platformPackage = '@colbymchenry/codegraph-' + target
    try {
      if (process.platform === 'win32') {
        cachedCommand = {
          command: require.resolve(platformPackage + '/node.exe'),
          args: [
            '--liftoff-only',
            '--disable-warning=ExperimentalWarning',
            require.resolve(platformPackage + '/lib/dist/bin/codegraph.js')
          ]
        }
        return cachedCommand
      }
      cachedCommand = { command: require.resolve(platformPackage + '/bin/codegraph'), args: [] }
      return cachedCommand
    } catch {
      // Fall back to the npm shim; it can locate a cached or downloaded bundle.
    }
  }

  cachedCommand = { command: process.execPath, args: [resolveCodegraphShim()] }
  return cachedCommand
}

export function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function trimOutput(text, max) {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n...[output truncated]...', truncated: true }
}

/**
 * Run the bundled CodeGraph CLI.
 *
 * The child never runs inside the project directory: see resolveSpawnCwd().
 * A `cwd` option is accepted for backward compatibility but ignored — the
 * project is always named explicitly on the command line.
 *
 * @param {string[]} args CLI arguments.
 * @param {{cwd?: string, signal?: AbortSignal, timeoutMs?: number, env?: Record<string,string>}} options
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, error?: Error, truncated?: boolean, timedOut?: boolean}>}
 */
export function runCodegraph(args, options = {}) {
  const { signal, timeoutMs = 0, env = {} } = options
  let launch
  try {
    launch = resolveCodegraphCommand()
  } catch (error) {
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', error })
  }

  if (signal && signal.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', error: new Error('aborted') })
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer

    const child = spawn(launch.command, [...launch.args, ...args], {
      cwd: resolveSpawnCwd(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubChildEnvironment({
        ELECTRON_RUN_AS_NODE: '1',
        CODEGRAPH_NO_DOWNLOAD: '1',
        ...env
      })
    })

    function finish(result) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    function terminate(reason) {
      if (reason === 'timeout') timedOut = true
      if (child.pid && process.platform === 'win32') {
        // npm-shim / bundled node may own a child process; taskkill /T takes
        // the whole tree down. /F is required for console children.
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          })
          killer.on('error', () => {})
        } catch { /* fall back to child.kill below */ }
      } else if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      }
      if (!child.killed) {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }, 1500)
        killTimer.unref?.()
      }
    }

    const onAbort = () => terminate('abort')
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const timer = timeoutMs > 0 ? setTimeout(() => terminate('timeout'), timeoutMs) : undefined
    timer?.unref?.()

    child.stdout.on('data', (chunk) => {
      if (stdout.length >= MAX_STDOUT_CHARS) return
      const text = chunk.toString()
      const room = MAX_STDOUT_CHARS - stdout.length
      stdout += text.length > room ? text.slice(0, room) : text
      if (text.length > room || stdout.length >= MAX_STDOUT_CHARS) {
        truncated = true
        terminate('output-limit')
      }
    })

    child.stderr.on('data', (chunk) => {
      if (stderr.length >= MAX_STDERR_CHARS) return
      const text = chunk.toString()
      const room = MAX_STDERR_CHARS - stderr.length
      stderr += text.length > room ? text.slice(0, room) : text
    })

    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), error })
    })

    child.on('close', (code, signalName) => {
      const out = trimOutput(stripAnsi(stdout), MAX_STDOUT_CHARS)
      const err = trimOutput(stripAnsi(stderr), MAX_STDERR_CHARS)
      finish({
        code,
        signal: signalName,
        command: typeof args[0] === 'string' ? args[0] : null,
        stdout: out.text,
        stderr: err.text,
        truncated: truncated || out.truncated || err.truncated,
        timedOut
      })
    })
  })
}

/**
 * Turn a launch failure into a thrown error instead of returning it as text.
 *
 * A missing binary or a failed spawn is a real fault. Rendering it as a normal
 * tool result is what taught the model that codegraph "works but replies
 * codegraph: spawn ... ENOENT", so it silently stopped calling it.
 *
 * @template T
 * @param {T} result
 * @returns {T}
 */
export function assertLaunched(result) {
  if (!result || !result.error) return result
  if (result.error.name === 'AbortError') throw result.error
  const error = new Error('CodeGraph CLI failed to start: ' + result.error.message)
  error.code = result.error.code || 'CODEGRAPH_SPAWN_FAILED'
  throw error
}

/**
 * Render a CLI result for the model, under a char budget.
 *
 * P0-1: the CLI can emit 97 KB (`files --json`) or 40 KB (`impact --json`)
 * and nothing capped it short of 8 MB — a per-turn token tax. The order here
 * matters: deduplicate known-wasteful JSON structure first (so the budget
 * spends on data), annotate empty results (so `[]` is not misread as a
 * failure), then apply middle truncation with an explicit omission notice.
 * The 8 MB stream cap stays as the hard backstop only.
 *
 * @param {{code?: number|null, signal?: string|null, stdout?: string, stderr?: string, error?: Error, truncated?: boolean, timedOut?: boolean, command?: string|null}} result
 * @param {{maxChars?: number, label?: string}} options
 * @returns {string}
 */
export function formatOutcome(result, options = {}) {
  if (result.error) {
    if (result.error.name === 'AbortError') return 'codegraph: aborted by the host.'
    return 'codegraph: ' + result.error.message
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const label = options.label ?? (result.command ? `codegraph ${result.command}` : 'codegraph output')

  let stdout = result.stdout ?? ''
  if (stdout.trim() && maxChars > 0) {
    let data = null
    const trimmed = stdout.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { data = JSON.parse(trimmed) } catch { /* plain text output */ }
    }
    if (data !== null && result.command) {
      const compacted = compactJsonForCommand(result.command, data)
      if (compacted != null) stdout = compacted
    }
    stdout = annotateEmpty(result.command, stdout)
    stdout = truncateMiddle(stdout, maxChars, label)
  }

  const parts = []
  if (stdout.trim()) parts.push(stdout.trim())
  if (result.stderr && result.stderr.trim()) parts.push('[stderr] ' + result.stderr.trim())
  if (result.truncated) parts.push('[stream truncated]')
  if (result.timedOut) parts.push('[timed out]')
  if (result.code !== 0) parts.push('[exit code: ' + result.code + ']')
  else if (result.signal) parts.push('[signal: ' + result.signal + ']')

  return parts.join('\n') || '(codegraph returned no output)'
}
