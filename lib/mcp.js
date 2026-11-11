// Minimal MCP stdio client for the CodeGraph resident server.
//
// CodeGraph's `serve --mcp` launcher spawns (or attaches to) a detached
// per-project daemon that owns the file watcher, the SQLite connection and the
// query workers.  Keeping one MCP child alive per workspace therefore gives us
// the same "edit -> index updates automatically" behaviour as the official
// `codegraph install` MCP server, instead of paying a cold CLI start per tool
// call.
//
// Crash recovery mirrors the official @deepseek-ai/dsh-mcp-client: an
// unexpected child exit schedules an automatic restart with exponential
// backoff (0.5 s doubling up to a 30 s cap). After 10 consecutive failed
// starts the server reports `fatal` and stops respawning; tool calls then
// surface the reason and fall back to the CLI instead of looping.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCodegraphCommand } from './cli.js'
import { scrubChildEnvironment } from './env.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const MAX_STDERR_CHARS = 8192

// Restart backoff schedule (same numbers as the official MCP client).
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 30000
const RESTART_MAX_ATTEMPTS = 10

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/**
 * One resident `codegraph serve --mcp` process bound to a workspace root.
 *
 * The class owns the stdio JSON-RPC transport; the actual index daemon is
 * detached by CodeGraph itself and shared with the official MCP server.
 */
export class McpServer {
  constructor(root, options = {}) {
    this.root = root
    this.options = options
    this.child = null
    this.buffer = ''
    this.stderr = ''
    this.pending = new Map()
    this.nextId = 0
    this.startPromise = null
    this.closed = true
    this.lastUsed = Date.now()
    this.activeCalls = 0
    this.serverInfo = null
    this.instructions = null
    // Restart/backoff bookkeeping. `consecutiveFailures` counts failed starts
    // in a row (every successful handshake resets it); `retryAt` is the
    // earliest allowed next start; `restarts` counts automatic crash
    // recoveries. `state` is one of
    // idle | starting | ready | dead | restarting | fatal | stopped.
    this.consecutiveFailures = 0
    this.retryAt = 0
    this.stopping = false
    this.restartTimer = null
    this.restartPromise = null
    this.restarts = 0
    this.lastError = null
    this.fatalError = null
    this.state = 'idle'
  }

  get running() {
    return Boolean(this.child) && !this.closed
  }

  /** Daemon pid recorded by CodeGraph in `.codegraph/daemon.pid`, if any. */
  get daemonPid() {
    try {
      const file = join(this.root, '.codegraph', 'daemon.pid')
      if (!existsSync(file)) return null
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return typeof data?.pid === 'number' ? data.pid : null
    } catch {
      return null
    }
  }

  /** Launcher child pid (not the detached daemon), for diagnostics/tests. */
  get childPid() {
    return this.child?.pid ?? null
  }

  touch() {
    this.lastUsed = Date.now()
  }

  async start() {
    if (this.running) return this
    if (this.state === 'fatal') {
      const error = new Error(this.fatalError || 'CodeGraph MCP server crashed repeatedly')
      error.fatal = true
      throw error
    }
    if (this.restartPromise) return this.restartPromise
    if (this.startPromise) return this.startPromise
    // An explicit start demand revives a server stopped earlier.
    this.stopping = false
    // Exponential backoff after a failed start: 0.5s, 1s, 2s, ... capped at
    // 30s (the official MCP client uses the same schedule). Waits are clamped
    // so a tool call never blocks for the full 30s.
    if (this.retryAt > Date.now()) {
      const wait = Math.min(this.retryAt - Date.now(), 5000)
      await new Promise((resolve) => setTimeout(resolve, wait))
      if (this.running) return this
    }
    this.state = 'starting'
    this.startPromise = this._start().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async _start() {
    const launch = resolveCodegraphCommand()
    const tools = this.options.tools || []
    const env = scrubChildEnvironment({
      ELECTRON_RUN_AS_NODE: '1',
      CODEGRAPH_NO_DOWNLOAD: '1'
    })
    if (tools.length > 0) env.CODEGRAPH_MCP_TOOLS = tools.join(',')

    const child = spawn(launch.command, [...launch.args, 'serve', '--mcp', '--path', this.root], {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    })

    this.child = child
    this.closed = false
    this.buffer = ''
    this.stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS)
    })
    child.once('error', (error) => this._onExit(null, null, error))
    child.once('exit', (code, signal) => this._onExit(code, signal))

    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-codegraph-plugin', version: '0.7.4' }
        },
        { timeoutMs: this.options.startTimeoutMs || 30000 }
      )
      this.serverInfo = result?.serverInfo || null
      this.instructions = typeof result?.instructions === 'string' && result.instructions.trim()
        ? result.instructions
        : null
      this.notify('notifications/initialized', {})
      this.consecutiveFailures = 0
      this.retryAt = 0
      this.state = 'ready'
      return this
    } catch (error) {
      this.consecutiveFailures += 1
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.consecutiveFailures - 1))
      this.retryAt = Date.now() + delay
      this.lastError = String(error?.message || error)
      // Deliberate cleanup — not stop(): it must not suppress auto-restarts.
      await this._teardown().catch(() => {})
      if (this.consecutiveFailures >= RESTART_MAX_ATTEMPTS) {
        this.state = 'fatal'
        this.fatalError = 'CodeGraph MCP server failed to start ' + RESTART_MAX_ATTEMPTS + ' times in a row: ' + this.lastError
        const fatal = new Error(this.fatalError)
        fatal.fatal = true
        throw fatal
      }
      this.state = 'dead'
      throw error
    }
  }

  _onStdout(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined || !this.pending.has(message.id)) continue
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  _onExit(code, signal, error) {
    const wasLive = !this.closed
    this.closed = true
    this.child = null
    const reason = error || new Error('CodeGraph MCP server exited (code ' + code + ', signal ' + signal + ')')
    this.lastError = String(reason?.message || reason)
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
    if (!wasLive) return
    if (this.stopping) {
      this.state = 'stopped'
      return
    }
    // A crash during the startup handshake is handled by the `_start` catch
    // (failure counters + retryAt); the in-flight call fails and the next
    // demand retries. Everything else — a healthy server dying underneath us —
    // gets an automatic reconnect with exponential backoff.
    if (this.startPromise) return
    this._scheduleRestart()
  }

  _clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  _scheduleRestart() {
    if (this.stopping || this.restartTimer) return
    if (this.consecutiveFailures >= RESTART_MAX_ATTEMPTS) {
      this.state = 'fatal'
      if (!this.fatalError) {
        this.fatalError = 'CodeGraph MCP server crashed ' + RESTART_MAX_ATTEMPTS + ' times in a row: ' + (this.lastError || 'unknown error')
      }
      return
    }
    const delay = this.retryAt > Date.now()
      ? Math.min(this.retryAt - Date.now(), RESTART_MAX_MS)
      : Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** this.consecutiveFailures)
    this.retryAt = Date.now() + delay
    this.restarts += 1
    this.state = 'restarting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const attempt = this.start()
      this.restartPromise = attempt.finally(() => {
        this.restartPromise = null
      })
      attempt.catch((error) => {
        if (this.stopping) return
        if (error?.fatal) return // state/fatalError already recorded by _start
        this._scheduleRestart()
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  request(method, params, options = {}) {
    if (this.closed || !this.child) return Promise.reject(new Error('CodeGraph MCP server is not running'))
    const { signal, timeoutMs = 0 } = options
    if (signal?.aborted) return Promise.reject(abortError())

    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const settle = (fn, value) => {
        cleanup()
        fn(value)
      }
      const onAbort = () => {
        this.pending.delete(id)
        settle(reject, abortError())
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          settle(reject, new Error('CodeGraph MCP request timed out after ' + timeoutMs + 'ms'))
        }, timeoutMs)
        timer.unref?.()
      }
      this.pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error)
      })
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        settle(reject, error)
      }
    })
  }

  notify(method, params) {
    if (this.closed || !this.child) return
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      // The exit handler will surface the failure on the next request.
    }
  }

  /**
   * Call one MCP tool and return its text content.
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {{signal?: AbortSignal, timeoutMs?: number}} options
   */
  async callTool(name, args, options = {}) {
    this.lastUsed = Date.now()
    this.activeCalls += 1
    try {
      const result = await this.request('tools/call', { name, arguments: args || {} }, options)
      const text = Array.isArray(result?.content)
        ? result.content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : ''
      if (result?.isError) {
        const error = new Error(text || 'CodeGraph MCP tool failed')
        error.isToolError = true
        throw error
      }
      return text
    } finally {
      this.activeCalls -= 1
      this.lastUsed = Date.now()
    }
  }

  async stop() {
    this.stopping = true
    this._clearRestartTimer()
    await this._teardown()
    this.state = 'stopped'
  }

  /** Kill the child and reject every pending request. Does not touch the
   * restart scheduler — that is `stop()`'s job for intentional shutdowns. */
  async _teardown() {
    const child = this.child
    this.child = null
    this.closed = true
    const error = new Error('CodeGraph MCP server stopped')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!child) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        resolve()
      }, 3000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill() } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
