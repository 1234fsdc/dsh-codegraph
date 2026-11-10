// Resident CodeGraph MCP servers, one per workspace root.
//
// Keeping the MCP launcher alive keeps CodeGraph's per-project daemon (and its
// file watcher) alive, so index updates happen automatically after edits.
// Servers are started lazily on first use and evicted LRU when a session works
// with more than `maxResidentProjects` workspaces.

import { McpServer } from './mcp.js'

const servers = new Map()
let enabled = true
let maxProjects = 3

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
  if (Array.isArray(options.mcpTools)) mcpTools = options.mcpTools.filter(Boolean)
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
  if (!server) return { configured: enabled, running: false, pid: null, activeCalls: 0 }
  return {
    configured: enabled,
    running: server.running,
    starting: Boolean(server.startPromise),
    pid: server.daemonPid,
    activeCalls: server.activeCalls
  }
}

export function listResidents() {
  return [...servers.entries()].map(([root, server]) => ({
    root,
    running: server.running,
    pid: server.daemonPid,
    activeCalls: server.activeCalls,
    lastUsed: server.lastUsed
  }))
}
