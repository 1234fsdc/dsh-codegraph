// Freshness guard for explore answers.
//
// When the watcher is dead (or between restarts) the index silently falls
// behind the working tree, and explore keeps quoting code that no longer
// exists. The official MCP guards this with answer-freshness
// (contentHash comparison); the CLI path has no hashes, so we compare mtimes:
// a file modified on disk after the index was last written is named in a
// warning attached to the answer.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Last moment the index learned anything: max(db mtime, wal mtime).
export function indexTimestamp(root) {
  let latest = 0;
  for (const name of ['codegraph.db', 'codegraph.db-wal', 'index.db', 'index.db-wal']) {
    try {
      const info = statSync(join(root, '.codegraph', name));
      latest = Math.max(latest, info.mtimeMs);
    } catch {
      /* not present */
    }
  }
  return latest || null;
}

// Best-effort content hash of up to maxFiles files inside timeoutMs. Returns
// {path, contentHash} rows in the shape answer-freshness.validateAnswerFiles
// would want if we ever route through the official MCP checker.
export async function hashFiles(root, paths, { timeoutMs = 250, maxFiles = 200 } = {}) {
  const capped = paths.slice(0, maxFiles);
  const signal = AbortSignal.timeout(timeoutMs);
  const rows = [];
  for (const rel of capped) {
    try {
      const info = await stat(join(root, rel), { signal });
      if (!info.isFile()) continue;
      const content = await readFile(join(root, rel), { signal });
      rows.push({ path: rel, contentHash: createHash('sha256').update(content).digest('hex') });
    } catch {
      /* missing or too slow — skipped, reported as unchecked by callers */
    }
  }
  return rows;
}

// Files the answer quotes whose disk mtime is newer than the index write.
export function staleFilesSince(root, paths, indexedAtMs) {
  if (!indexedAtMs) return { stale: [], unchecked: paths.slice() };
  const stale = [];
  const unchecked = [];
  for (const rel of paths) {
    try {
      const info = statSync(join(root, rel));
      (info.mtimeMs > indexedAtMs ? stale : unchecked).push(rel);
    } catch {
      unchecked.push(rel);
    }
  }
  return { stale, unchecked };
}

export function freshnessWarning(stale, indexedAtMs) {
  if (!stale || stale.length === 0) return null;
  const when = indexedAtMs ? new Date(indexedAtMs).toISOString() : 'unknown';
  const names = stale.slice(0, 10).join(', ') + (stale.length > 10 ? `, +${stale.length - 10} more` : '');
  return (
    `⚠️ Freshness warning: ${stale.length} file(s) changed on disk after the index was last written (${when}): ${names}. ` +
    'Lines from these files may be out of date — run codegraph_sync or re-run explore after the watcher catches up.'
  );
}
