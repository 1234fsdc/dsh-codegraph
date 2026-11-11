// Filesystem-only readiness probe for CodeGraph indexes.
//
// `codegraph status --json` has to open the whole SQLite database to report
// file/node/edge counts: 1.4-1.6 s on a 2.5 GB index, and it was previously
// executed before *every* tool call.  The index location itself is a fixed,
// well-known path (`<project>/.codegraph/codegraph.db`), so probing the
// filesystem answers "is this project indexed?" in well under a millisecond.
// The CLI status is now only consulted when no index exists (to explain why)
// or when a full report is explicitly requested.

import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk up from `start` looking for a CodeGraph index.
 * @param {string} start
 * @returns {{indexRoot: string, dbPath: string, mtimeMs: number, size: number} | null}
 */
export function probeIndex(start) {
  let dir = resolve(start)
  for (;;) {
    const dbPath = join(dir, '.codegraph', 'codegraph.db')
    try {
      const info = statSync(dbPath)
      if (info.isFile()) {
        return { indexRoot: dir, dbPath, mtimeMs: info.mtimeMs, size: info.size }
      }
    } catch {
      // Not here; keep walking up. ENOENT/EPERM both mean "no index here".
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
