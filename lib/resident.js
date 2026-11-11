// Resident CodeGraph MCP servers, one per indexed project root.
//
// Keeping the MCP launcher alive keeps CodeGraph's per-project daemon (and its
// file watcher) alive, so index updates happen automatically after edits.
// Servers are started lazily on first use, evicted LRU when the session works
// with more than `maxResidentProjects` projects, and reaped after
// `residentIdleTimeoutMs` without a call (0 disables the reaper) — the same
// shape as DSH's own persistent sessions (owner-scoped, idle timeout, 0 = keep).
//
// The key is the *index* root, not the session cwd: a session that works in
// `repo/packages/foo` while the index lives in `repo` reuses the one server
// that CodeGraph would otherwise start for `repo`, instead of spawning a
// second launcher for a directory that has no index of its own.

import { McpServer } from './mcp.js'

const servers = new Map()
let enabled = true
let maxProjects = 3
/** Idle reap threshold in ms; 0 keeps servers until the plugin unloads. */
let idleTimeoutMs = 900000
const SWEEP_INTERVAL_MS = 60000
let sweepTimer = null
/**
 * MCP tools the resident server may serve. Only `explore` is called over MCP;
 * the other native tools use the CLI to keep their JSON/markdown output shapes.
 * Defaults to the official `codegraph install` surface.
 */
export const DEFAULT_MCP_TOOLS = ['explore']
let mcpTools = [...DEFAULT_MCP_TOOLS]

export function configureResident(options = {}) {
  enabled = options.enabled !== false
  const limit = Number(options.maxProjects)
  maxProjects = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3
  const idle = Number(options.idleTimeoutMs)
  idleTimeoutMs = Number.isFinite(idle) && idle >= 0 ? Math.floor(idle) : 900000
  if (Array.isArray(options.mcpTools)) mcpTools = options.mcpTools.filter(Boolean)
  startSweeper()
}

function startSweeper() {
  if (sweepTimer || !enabled || idleTimeoutMs <= 0) return
  sweepTimer = setInterval(() => { sweepIdle().catch(() => {}) }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

export function stopResidentSweeper() {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
}

/**
 * Stop every resident that has been idle for longer than the configured
 * threshold. In-flight calls and servers still completing their handshake are
 * never touched, so a reap can never kill a running query.
 * @returns {Promise<string[]>} roots that were stopped
 */
export async function sweepIdle(now = Date.now()) {
  if (!enabled || idleTimeoutMs <= 0) return []
  const victims = []
  for (const [root, server] of servers) {
    if (server.activeCalls > 0 || server.startPromise) continue
    if (server.state === 'starting' || server.state === 'restarting') continue
    if (now - server.lastUsed < idleTimeoutMs) continue
    victims.push([root, server])
  }
  for (const [root, server] of victims) {
    servers.delete(root)
    await server.stop().catch(() => {})
  }
  return victims.map(([root]) => root)
}

export function residentFor(root) {
  return servers.get(root) || null
}

/**
 * Ensure a resident server exists and has completed the MCP handshake.
 * @param {string} root
 * @param {{startTimeoutMs?: number}} options
 */
export async function ensureResident(root, options = {}) {
  if (!enabled) return null
  let server = servers.get(root)
  if (!server) {
    server = new McpServer(root, { tools: mcpTools, startTimeoutMs: options.startTimeoutMs })
    servers.set(root, server)
    await evictIfNeeded(root)
  }
  server.touch()
  await server.start()
  return server
}

/** Start the resident server without waiting for the handshake. */
export function warmResident(root, options = {}) {
  if (!enabled) return
  ensureResident(root, options).catch(() => {})
}

async function evictIfNeeded(protectedRoot) {
  while (servers.size > maxProjects) {
    let victim = null
    for (const [root, server] of servers) {
      if (root === protectedRoot || server.activeCalls > 0) continue
      if (!victim || server.lastUsed < victim.server.lastUsed) victim = { root, server }
    }
    if (!victim) return
    servers.delete(victim.root)
    await victim.server.stop().catch(() => {})
  }
}

export async function stopResident(root) {
  const server = servers.get(root)
  if (!server) return
  servers.delete(root)
  await server.stop().catch(() => {})
}

export async function stopAllResidents() {
  const all = [...servers.values()]
  servers.clear()
  await Promise.allSettled(all.map((server) => server.stop()))
}

export function residentStatus(root) {
  const server = servers.get(root)
  if (!server) return { configured: enabled, running: false, starting: false, pid: null, activeCalls: 0, idleTimeoutMs }
  return {
    configured: enabled,
    running: server.running,
    starting: Boolean(server.startPromise),
    pid: server.daemonPid,
    activeCalls: server.activeCalls,
    state: server.state,
    restarts: server.restarts,
    lastError: server.lastError,
    restartScheduled: Boolean(server.restartTimer),
    childPid: server.childPid,
    idleTimeoutMs,
    idleForMs: Date.now() - server.lastUsed
  }
}

export function listResidents() {
  return [...servers.entries()].map(([root, server]) => ({
    root,
    running: server.running,
    pid: server.daemonPid,
    activeCalls: server.activeCalls,
    lastUsed: server.lastUsed,
    state: server.state,
    restarts: server.restarts,
    lastError: server.lastError,
    childPid: server.childPid,
    idleForMs: Date.now() - server.lastUsed
  }))
}
