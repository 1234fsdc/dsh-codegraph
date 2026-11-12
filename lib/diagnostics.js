// Explore answer diagnostics.
//
// "explore returned the wrong files" was unanswerable with the old tool: the
// output showed the chosen files but never why. The official MCP has
// explore-diagnostics behind CODEGRAPH_EXPLORE_DEBUG; the CLI fallback does
// not, so we build a minimal, self-contained report from the answer's own
// file headers: which files the answer drew from and how the character
// budget was spent across them.

const FILE_HEADER_RE = /^\*\*`([^`]+)`\*\*/gm;

export function extractExploreFiles(text) {
  if (typeof text !== 'string') return [];
  const files = [];
  for (const match of text.matchAll(FILE_HEADER_RE)) {
    const path = match[1];
    const last = files[files.length - 1];
    if (last && last.path === path) {
      last.blocks += 1;
      continue;
    }
    files.push({ path, blocks: 1 });
  }
  return files;
}

// One section per explore call, appended only when requested. `score` is
// deliberately n/a: ranking happens inside the official server and is not
// part of the CLI answer text.
export function buildExploreDiagnostics(text, { fileCount = null, budget = null, maxFiles = null } = {}) {
  const files = extractExploreFiles(text);
  if (files.length === 0) return null;
  const fileBytes = new Map();
  let cursor = 0;
  for (const match of text.matchAll(FILE_HEADER_RE)) {
    const start = match.index;
    if (cursor < start) {
      const prev = files[fileBytes.size - 1];
      if (prev) fileBytes.set(prev.path, (fileBytes.get(prev.path) ?? 0) + (start - cursor));
    }
    const next = text.indexOf('\n', match.index + match[0].length);
    cursor = next === -1 ? text.length : next + 1;
    fileBytes.set(match[1], fileBytes.get(match[1]) ?? 0);
  }
  if (cursor < text.length) {
    const prev = files[files.length - 1];
    if (prev) fileBytes.set(prev.path, (fileBytes.get(prev.path) ?? 0) + (text.length - cursor));
  }
  const total = text.length;
  const lines = [];
  lines.push('## Answer diagnostics');
  lines.push(`- files included: ${files.length}${maxFiles != null ? ` / maxFiles ${maxFiles}` : ''}`);
  if (budget) {
    lines.push(
      `- budget: ${budget.maxOutputChars} chars (hard ceiling ${Math.min(Math.round(budget.maxOutputChars * 1.5), 25000)}), ` +
        `answer used ${total}`
    );
  } else {
    lines.push(`- answer size: ${total} chars`);
  }
  if (fileCount != null) lines.push(`- indexed files: ${fileCount}`);
  for (const file of files) {
    const chars = fileBytes.get(file.path) ?? 0;
    const share = total > 0 ? ((chars / total) * 100).toFixed(1) + '%' : 'n/a';
    lines.push(`  - ${file.path}: ${chars} chars (${share})${file.blocks > 1 ? `, ${file.blocks} blocks` : ''}`);
  }
  lines.push('- ranking score: n/a (the CLI answer does not carry per-file scores; scores live in the resident MCP diagnostics)');
  return lines.join('\n');
}
