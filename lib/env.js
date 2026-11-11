// Child environment policy for every process this plugin spawns.
//
// DSH's rule for a child process is: "Children never inherit the harness's
// ambient secrets: credential-shaped names and ambient DSH_* facts are
// scrubbed, and the caller's explicit env merges after that scrub."
// (@deepseek-ai/dsh-subprocess/README.md:80). The same README tells a transport
// that owns its own spawn to import `scrubbedParentEnv` from
// @deepseek-ai/dsh-subprocess directly so the policy stays single-sourced
// (README.md:84). Both the resident MCP launcher (lib/mcp.js) and the CLI
// wrapper (lib/cli.js) route through here for exactly that reason.
//
// The dynamic import is best-effort: a profile's @deepseek-ai links can point at
// a stale application path, in which case the equivalent inline implementation
// below is used. It implements the same rule line by line.

const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
const AMBIENT_PREFIX = 'DSH_'

let scrubbedParentEnv

try {
  const module = await import('@deepseek-ai/dsh-subprocess')
  if (typeof module.scrubbedParentEnv === 'function') {
    scrubbedParentEnv = module.scrubbedParentEnv
  }
} catch {
  scrubbedParentEnv = null
}

/**
 * Build the environment for a CodeGraph child process.
 *
 * @param {Record<string, string>} explicit entries merged after the scrub
 * @returns {Record<string, string>}
 */
export function scrubChildEnvironment(explicit = {}) {
  const base = scrubbedParentEnv ? scrubbedParentEnv() : scrubLocally()
  return Object.assign(base, explicit)
}

function scrubLocally() {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(name)) continue
    if (name.startsWith(AMBIENT_PREFIX)) continue
    env[name] = value
  }
  return env
}
