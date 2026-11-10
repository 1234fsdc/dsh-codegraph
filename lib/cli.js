// Resolve and run the CodeGraph CLI bundled with this plugin.
//
// @colbymchenry/codegraph deliberately exposes only "." and "./package.json"
// in its package exports, so the npm-shim entry cannot be resolved directly.
// Resolve package.json first, then join npm-shim.js next to it.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
const MAX_STDOUT_CHARS = 8 * 1024 * 1024
const MAX_STDERR_CHARS = 2 * 1024 * 1024

let cachedShimPath
let cachedCommand

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
 * @param {string[]} args CLI arguments.
 * @param {{cwd?: string, signal?: AbortSignal, timeoutMs?: number, env?: Record<string,string>}} options
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, error?: Error, truncated?: boolean, timedOut?: boolean}>}
 */
export function runCodegraph(args, options = {}) {
  const { cwd, signal, timeoutMs = 0, env = {} } = options
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
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEGRAPH_NO_DOWNLOAD: '1',
        ...env
      }
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
        stdout: out.text,
        stderr: err.text,
        truncated: truncated || out.truncated || err.truncated,
        timedOut
      })
    })
  })
}

export function formatOutcome(result) {
  if (result.error) {
    if (result.error.name === 'AbortError') return 'codegraph: aborted by the host.'
    return 'codegraph: ' + result.error.message
  }

  const parts = []
  if (result.stdout.trim()) parts.push(result.stdout.trim())
  if (result.stderr.trim()) parts.push('[stderr] ' + result.stderr.trim())
  if (result.truncated) parts.push('[output truncated]')
  if (result.timedOut) parts.push('[timed out]')
  if (result.code !== 0) parts.push('[exit code: ' + result.code + ']')
  else if (result.signal) parts.push('[signal: ' + result.signal + ']')

  return parts.join('\n') || '(codegraph returned no output)'
}
