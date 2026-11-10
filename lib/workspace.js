import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PROJECT_MARKERS = [
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'CMakeLists.txt',
  '*.sln',
  '*.csproj'
]

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.codegraph',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo'
])

export async function getWorkspaceRoot(ctx, exec) {
  if (exec?.agent && ctx?.workingDirectory?.ensure) {
    try {
      const root = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      if (typeof root === 'string' && root.length > 0) return root
    } catch {
      // fall through to the session header / process cwd
    }
  }

  const header = exec?.agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd
  return process.cwd()
}

export async function resolveProjectRoot(ctx, exec, requestedPath) {
  const workspace = await getWorkspaceRoot(ctx, exec)
  if (typeof requestedPath === 'string' && requestedPath.trim().length > 0) {
    return resolve(workspace, requestedPath.trim())
  }
  return workspace
}

export async function isProjectRoot(root) {
  for (const marker of PROJECT_MARKERS) {
    if (marker.startsWith('*.')) {
      try {
        const entries = await readdir(root)
        const suffix = marker.slice(1)
        if (entries.some((entry) => entry.endsWith(suffix))) return true
      } catch {
        // ignore unreadable directories
      }
    } else if (existsSync(join(root, marker))) {
      return true
    }
  }
  return false
}

export async function countFiles(root, limit = 5000) {
  let count = 0
  const max = Math.max(0, Number(limit) || 0)

  async function walk(dir) {
    if (count > max) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count > max) return
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        count += 1
      }
    }
  }

  await walk(root)
  return count
}
