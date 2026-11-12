# CodeGraph — code intelligence over an indexed knowledge graph

CodeGraph is a SQLite knowledge graph of every symbol, edge and file in the
workspace — pre-computed structure you would otherwise re-derive by reading
files. It indexes 30+ languages (TypeScript/JavaScript, Python, Go, Rust, Java,
C#, C/C++, PHP, Ruby, Swift, Kotlin, and more) — don't assume a language here
isn't covered. Reads come from the pre-built index, not a live file scan. Reach
for it BEFORE *and* while writing or editing code — not just for
questions: one call returns the verbatim source PLUS who calls it and what it
affects, so you edit with the blast radius in view.

## Primary tool: codegraph_explore — use it instead of reading files

`codegraph_explore` is Read-equivalent. It takes either a natural-language
question or a bag of symbol/file names and returns the **verbatim,
line-numbered source** of the relevant symbols grouped by file — the same
`<n>\t<line>` shape `Read` gives you, safe to `Edit` from — PLUS the call path
among them (including dynamic-dispatch hops like callbacks, React re-render and
JSX children that grep can't follow) and a blast-radius summary of what depends
on them.

Whether you are answering "how does X work" or implementing a change, call
`codegraph_explore` before you Read. ONE call usually answers the whole
question. CodeGraph IS the pre-built search index — running your own
grep + read loop, or delegating the lookup to a file-reading sub-agent, repeats
work it already did and costs more for the same answer. A direct CodeGraph
answer is typically one to a few calls; a grep/read exploration is dozens.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", surveying an area** → `codegraph_explore` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → `codegraph_explore`, naming the symbols that span the flow (e.g. `mutateElement renderScene`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the `codegraph_explore` query — it returns that current line-numbered source (safe to `Edit` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Need more?** Call `codegraph_explore` again with more specific names — treat the source it returns as already Read. Suggested call counts are advisory only, NOT a quota; extra calls are never rejected or rate-limited.
- Qualified symbol names accept dots, `::`, or slashes, including containers whose names contain dots (for example, `AppWeb.Format.group`).
- Named-symbol call paths require exact matches; partial or mistyped names are never silently substituted as flow endpoints. If a graph query reports a missing symbol with did-you-mean suggestions, query the suggested name explicitly.
- Explore matches names and indexed code words lexically, not by meaning; an empty result reports word matches and may suggest indexed candidate names to retry with.

## Anti-patterns

- **Trust CodeGraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE `codegraph_explore` returns the relevant symbols' source in a single round-trip. Reach for raw `Read`/`Grep` only to confirm a specific detail CodeGraph didn't cover, or for what it doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one `codegraph_explore` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust CodeGraph. A different, rarer banner — "⚠️ CodeGraph auto-sync is DISABLED…" or "⚠️ CodeGraph auto-sync is RECOVERING…" — means the whole index may be stale; until the full catch-up completes, Read files directly to confirm anything that may have changed. If a response refuses to answer from changed files or says freshness could not be verified within its budget, retry after sync or narrow the query; that refusal is not an error in the tool.
- **A file flagged "⚠ changed on disk after the last index sync" drifted from its index.** CodeGraph never serves a possibly-mis-sliced body from such a file — it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag. When the source was omitted, Read that specific file; line numbers referencing it elsewhere in the response may be shifted until that project's next sync. All unflagged files remain trustworthy.
- **Source is re-served on every call by default**, including for fresh subagents and after context compaction. Cross-call dedup requires `CODEGRAPH_EXPLORE_DEDUP=1` and is only suitable for hosts that guarantee one durable context per connection. With that opt-in, **"Already sent earlier in this conversation"** points to exact, unchanged source returned by an earlier `codegraph_explore` in that context. Use that copy; don't re-fetch it and don't Read the file.

## Limitations

- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the compiler / test suite / linter's job. CodeGraph supplements those with structural context they don't have.
- CodeGraph indexes real directories on disk. Virtual paths (anything inside an `.asar` archive, such as the DSH checkout) and paths that do not exist cannot be indexed — use `read`/`grep`/`glob` there.

## This installation (DeepSeek Harness)

CodeGraph here is a native DSH plugin, not the standalone MCP server: the tools
are `codegraph_*` rather than a bare MCP surface, and `codegraph_init` is a real
tool you can call in this conversation. `codegraph_explore` is the primary tool.
The inventory at the end of this document is authoritative — it lists exactly
what this session registered, and nothing else exists.

- {{INIT_POLICY}}
{{WATCHER}}
{{OUTPUT_BUDGET}}
{{EXTRA_TOOLS}}