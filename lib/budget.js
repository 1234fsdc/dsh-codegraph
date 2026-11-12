// Output budgets shared by every codegraph_* tool.
//
// The bundled CLI prints unbounded stdout (97 KB for `files --json` on a
// mid-size repo, 40 KB for a single `impact --json`). DSH only prunes tool
// results when the whole context overflows, so every character we do not cap
// here is re-billed on every turn. The explore tiers mirror the official MCP
// implementation (`mcp/tools.js getExploreOutputBudget` / `getExploreBudget`).

export const DEFAULT_MAX_OUTPUT_CHARS = 15000;
export const EXPLORE_MAX_OUTPUT_CHARS = 24000;

// Official explore output tier: how many files / how many chars one explore
// call should emit for a repo of this size.
export function exploreOutputBudget(fileCount) {
  const n = Number(fileCount) || 0;
  if (n < 150) return { maxOutputChars: 13000, defaultMaxFiles: 4, maxCharsPerFile: 3800 };
  if (n < 500) return { maxOutputChars: 18000, defaultMaxFiles: 5, maxCharsPerFile: 3800 };
  if (n < 5000) return { maxOutputChars: 24000, defaultMaxFiles: 8, maxCharsPerFile: 6500 };
  return { maxOutputChars: 24000, defaultMaxFiles: 8, maxCharsPerFile: 7000 };
}

// Official explore call budget: how many explore calls the model should plan
// for a repo of this size.
export function exploreCallBudget(fileCount) {
  const n = Number(fileCount) || 0;
  if (n < 500) return 1;
  if (n < 5000) return 2;
  if (n < 15000) return 3;
  if (n < 25000) return 4;
  return 5;
}

// The MCP server can overrun its own budget by up to 1.5x, never above 25000.
export function hardCeilingFor(budget) {
  const base = budget?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return Math.min(Math.round(base * 1.5), 25000);
}

// Middle truncation with an explicit accounting notice. The head keeps the
// query answer, the tail keeps the conclusion, and the model is told exactly
// what was dropped — an unexplained cap is worse than a bigger cap.
export function truncateMiddle(text, maxChars, label = 'output') {
  if (typeof text !== 'string') return text;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const lines = text.split('\n');
  const notice = (omittedLines, omittedChars) =>
    `\n…[${label} truncated: omitted ${omittedLines} middle line${omittedLines === 1 ? '' : 's'} ` +
    `(${omittedChars} chars); total ${text.length} chars, limit ${maxChars}]…\n`;
  const headBudget = Math.floor(maxChars * 0.6);
  let headLines = 0;
  let headLen = 0;
  while (headLines < lines.length) {
    const add = lines[headLines].length + 1;
    if (headLines > 0 && headLen + add > headBudget) break;
    headLen += add;
    headLines++;
  }
  let tailLines = 0;
  let tailLen = 0;
  const remaining = lines.length - headLines;
  while (tailLines < remaining) {
    const add = lines[lines.length - 1 - tailLines].length + 1;
    const noticeLen = notice(lines.length - headLines - (tailLines + 1), 0).length;
    if (tailLines > 0 && headLen + tailLen + add + noticeLen > maxChars) break;
    tailLen += add;
    tailLines++;
  }
  let head = lines.slice(0, headLines).join('\n');
  let tail = tailLines > 0 ? '\n' + lines.slice(lines.length - tailLines).join('\n') : '';
  const omittedLines = Math.max(0, lines.length - headLines - tailLines);
  const omittedChars = Math.max(0, text.length - headLen - tailLen);
  let result = head + notice(omittedLines, omittedChars) + tail;
  if (result.length > maxChars + notice(0, 0).length + 64) {
    // One monster line (minified JSON, a huge fence) — hard-slice instead.
    const keep = Math.max(0, maxChars - notice(0, text.length - Math.max(0, maxChars - 200)).length - 8);
    head = text.slice(0, keep);
    tail = '';
    result = head + notice(Math.max(0, lines.length - 1), text.length - keep) + tail;
  }
  return result;
}

// Command-specific JSON compaction applied BEFORE the char budget, so the
// budget spends on data instead of duplicated structure.
export function compactJsonForCommand(command, data) {
  if (command === 'files' && Array.isArray(data)) {
    // One row per line: the JSON stays valid while middle truncation can drop
    // entire rows instead of slicing the middle of a minified array.
    const rows = data.map((file) =>
      JSON.stringify({ path: file.path, language: file.language, nodes: file.nodeCount })
    );
    return '[\n' + rows.join(',\n') + '\n]';
  }
  if (
    (command === 'impact' || command === 'callers' || command === 'callees') &&
    data && typeof data === 'object' && Array.isArray(data.definitions)
  ) {
    const definitions = data.definitions.map((def) => {
      if (!def || typeof def !== 'object') return def;
      const out = { ...def };
      for (const key of ['affected', 'callers', 'callees']) {
        // The top-level union already carries the same rows; keep a count
        // instead of duplicating them per definition.
        if (Array.isArray(out[key]) && Array.isArray(data[key])) {
          out[`${key}Count`] = out[key].length;
          out[`${key}Omitted`] = `same rows as top-level ${key}`;
          delete out[key];
        }
      }
      if (Array.isArray(out.edges)) {
        out.edgeCount = out.edges.length;
        delete out.edges;
      }
      return out;
    });
    return JSON.stringify({ ...data, definitions });
  }
  return null;
}

// The official CLI exits 0 for "nothing matched"; without a note the model
// reads `[]` as a fault or as proof the symbol does not exist anywhere.
export function annotateEmpty(command, text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const trimmed = text.trim();
  if (trimmed === '[]' || trimmed === '') {
    const noun = command === 'query' ? 'no symbol matched the search' : 'no entries were returned';
    return text + `\n\n(empty result: ${noun} — the CLI exited successfully, this is data, not a failure)`;
  }
  if (/^no results found/i.test(trimmed)) {
    return text + '\n\n(empty result: the CLI reported no matches — this is data, not a failure)';
  }
  // The CLI also exits 0 with prose for "no such symbol" / "no such file".
  // The same reasoning applies: the command succeeded and found nothing.
  if (/not found in the codebase/i.test(trimmed)) {
    return text + '\n\n(empty result: no symbol matched — the CLI exited successfully, this is data, not a failure)';
  }
  if (/^no indexed file matches/i.test(trimmed)) {
    return text + '\n\n(empty result: no indexed file matched — the CLI exited successfully, this is data, not a failure)';
  }
  return text;
}
