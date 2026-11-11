// Minimal MCP stdio client for the CodeGraph resident server.
//
// CodeGraph's `serve --mcp` launcher spawns (or attaches to) a detached
// per-project daemon that owns the file watcher, the SQLite connection and the
// query workers.  Keeping one MCP child alive per workspace therefore gives us
// the same "edit -> index updates automatically" behaviour as the official
// `codegraph install` MCP server, instead of paying a cold CLI start per tool
// call.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCodegraphCommand } from './cli.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const MAX_STDERR_CHARS = 8192

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

  touch() {
    this.lastUsed = Date.now()
  }

  start() {
    if (this.running) return Promise.resolve(this)
    if (!this.startPromise) {
      this.startPromise = this._start().finally(() => {
        this.startPromise = null
      })
    }
    return this.startPromise
  }

  async _start() {
    const launch = resolveCodegraphCommand()
    const tools = this.options.tools || []
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODEGRAPH_NO_DOWNLOAD: '1'
    }
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
          clientInfo: { name: 'dsh-codegraph-plugin', version: '0.4.0' }
        },
        { timeoutMs: this.options.startTimeoutMs || 30000 }
      )
      this.serverInfo = result?.serverInfo || null
      this.instructions = typeof result?.instructions === 'string' && result.instructions.trim()
        ? result.instructions
        : null
      this.notify('notifications/initialized', {})
      return this
    } catch (error) {
      await this.stop().catch(() => {})
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
    const reason = error || new Error('CodeGraph MCP server exited (code ' + code + ', signal ' + signal + ')')
    this.closed = true
    this.child = null
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
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
