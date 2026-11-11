# dsh-codegraph

Native [CodeGraph](https://github.com/colbymchenry/codegraph) tools for DeepSeek Harness. The npm package is `dsh-codegraph-plugin`; the project repository is [dsh-codegraph](https://github.com/1234fsdc/dsh-codegraph).

`dsh-codegraph-plugin` turns the CodeGraph CLI into native DSH tools. It bundles `@colbymchenry/codegraph@1.6.2`, so installing the plugin is enough — you do not need a global `codegraph` command. It keeps a resident CodeGraph MCP server per workspace (daemon + file watcher), the same architecture the official `codegraph install` uses, and follows the official explore-first tool surface.

## Install

From GitHub:

```bash
dsh plugin --profile desktop add -w --save-exact github:1234fsdc/dsh-codegraph
```

Pin a release with `github:1234fsdc/dsh-codegraph#v0.5.0`.

From a release tarball:

```bash
dsh plugin --profile desktop add -w --save-exact /absolute/path/to/dsh-codegraph-plugin-0.5.0.tgz
```

From a local checkout:

```bash
dsh plugin --profile desktop add -w /absolute/path/to/dsh-codegraph
```

From npm (after publishing):

```bash
dsh plugin --profile desktop add -w dsh-codegraph-plugin
```

Replace `desktop` with the DSH profile you use. Restart DSH if the plugin manager does not hot-load the new bundle.

## Tools

By default the plugin follows the official `codegraph install` surface: only `codegraph_explore` is listed to the agent. The official source keeps the narrower tools defined but does not list them, because "presence itself steers mis-picks" — its A/B data shows a search-only surface turned a 43% token saving on express into a 107% loss. `codegraph_init` is always listed as the bootstrap tool, because initialization is explicit by default and an unindexed project needs a way to build its index.

| Tool | What it does | Default |
| --- | --- | --- |
| `codegraph_init` | Build the first index (creates `.codegraph/`); pass `force: true` to rebuild. | always |
| `codegraph_explore` | Return relevant symbols' verbatim source plus call paths in one shot. | default |
| `codegraph_status` | Show whether the current project has a CodeGraph index and print counts. | off |
| `codegraph_sync` | Incrementally update the index after edits. | off |
| `codegraph_query` | Search symbols by name and return matching nodes as JSON. | off |
| `codegraph_node` | Show one symbol with its caller/callee trail, or read a file with line numbers. | off |
| `codegraph_files` | Show the indexed file structure with language and symbol metadata. | off |
| `codegraph_callers` | Find functions/methods that call a symbol. | off |
| `codegraph_callees` | Find functions/methods a symbol calls. | off |
| `codegraph_impact` | Analyze what code is affected by changing a symbol. | off |
| `codegraph_affected` | Find test files affected by changed source files. | off |

### Tool surface

The `tools` config controls which tools are listed. It accepts:

- `['explore']` (default) — the official surface;
- `'all'` — every tool, including the 10 above;
- a comma-separated string such as `"explore,query,node"`;
- a list such as `["explore", "status", "query"]`.

Short names and `codegraph_`-prefixed names both work. Like the official
`CODEGRAPH_MCP_TOOLS` allowlist this is a **load-time** decision: the tools are
registered when the plugin loads, so changing it requires reloading the plugin
(HMR or restart) — they do not appear mid-session.

`codegraph_init` is always registered regardless of `tools` so an unindexed
project can be initialized.

## Resident index watcher

Starting with 0.2.0 the plugin keeps one CodeGraph MCP server alive per workspace, the same architecture the official `codegraph install` uses. The MCP launcher owns a detached CodeGraph daemon with a file watcher, a single SQLite connection and a warm query pool. As a result:

- Edits are re-indexed automatically within about a second; `codegraph_sync` is only a manual fallback.
- `codegraph_explore` is served over MCP instead of starting a CLI process per call. On the reference 2.47 GB / 607-file workspace a warm MCP explore takes about 0.1 s versus about 1.1 s for a cold CLI run.
- Each tool call answers "is this project indexed?" with a filesystem probe of `<root>/.codegraph/codegraph.db` (well under 1 ms) instead of running `codegraph status --json`, which has to open and scan the whole database (1.4-1.6 s on the 2.5 GB reference index). The CLI status is only consulted when no index exists, to explain why and to drive `autoInit`.
- Startup happens lazily on the first tool call for a workspace and costs a few hundred milliseconds. The watcher uses roughly 150 MB of memory per active workspace.

Crash recovery matches the official `@deepseek-ai/dsh-mcp-client`: if the MCP launcher exits unexpectedly, the plugin schedules an automatic restart with exponential backoff (0.5 s doubling up to a 30 s cap). In-flight tool calls fail once; the detached CodeGraph daemon keeps running, so the file watcher never stops and the restarted launcher re-attaches to the same daemon. After 10 consecutive failed starts the resident server reports `fatal` — `codegraph_status` shows the last error and the auto-restart count, every call falls back to the CLI, and a successful `codegraph_sync` (or a plugin reload) replaces the server.

Resident servers are keyed by the **index root**, not by the session working directory. A session that works in `repo/packages/foo` while the index lives in `repo` reuses the one server (and one watcher) for `repo`; it does not start a second launcher for a directory that has no `.codegraph` of its own.

Servers that go quiet are reaped after `residentIdleTimeoutMs` (default 15 minutes, `0` keeps them for the whole DSH process lifetime). In-flight calls and servers still completing their handshake are never reaped, so a reap cannot kill a running query. This mirrors DSH's own persistent-session shape — owner-scoped, an explicit unattended timeout, `0` = keep — rather than binding the processes to the plugin's lifetime only.

The resident servers are stopped when the plugin unloads. The CodeGraph daemon itself is shared per project and exits after its idle timeout (CodeGraph default: 5 minutes).

```yaml
- id: dsh-codegraph-plugin
  name: dsh-codegraph-plugin
  config:
    resident: true              # false = CLI-only mode, one process per call
    maxResidentProjects: 3      # LRU limit for simultaneously watched projects
    residentStartTimeoutMs: 30000
    residentIdleTimeoutMs: 900000  # reap a quiet server after 15 min; 0 = keep
```

## Child processes

Every CodeGraph process this plugin spawns — the resident MCP launcher and the CLI fallback — builds its environment through `lib/env.js`, following DSH's rule that a child never inherits the host's ambient secrets: names matching `/KEY|PASSWORD|SECRET|TOKEN/i` and every `DSH_*` variable are dropped, and the plugin's own settings are merged after the scrub (`@deepseek-ai/dsh-subprocess/README.md:80`). When `@deepseek-ai/dsh-subprocess` is resolvable the plugin reuses its `scrubbedParentEnv` directly so the policy stays single-sourced; otherwise the same rule is applied inline. Before 0.7.4 both spawners passed `...process.env` straight through, which could hand host credentials such as `DEEPSEEK_API_KEY` to the CodeGraph child.

## Working directory and failures

CodeGraph children never run *inside* the project: `spawn` receives a private temp directory (`resolveSpawnCwd()` in `lib/cli.js`), and the project is always named explicitly — `--path <root>` for MCP and explore, a positional root for the rest. Node validates `cwd` before the binary starts, so pointing it at the project root used to fail with ENOENT for any path that is not a real directory: virtual paths such as `...\app.asar\dsh\` (DSH prints its own asar checkout in every session prompt, so the model eventually passes it) and projects that do not exist yet. Every command already carried its project, so the working directory had no semantic value — in 0.8.0 it could only break a call.

Failures are now split in two classes:

- **Expected conditions** — no index yet, `path` is not a directory, `path` points inside an `.asar` archive, automatic init declined — return a *normal* tool result carrying guidance ("use the built-in read/grep/glob tools", "run codegraph_init"). They are never `isError`: the official server refuses sensitive paths the same way, because "an `isError: true` early in a session teaches the agent the toolset is broken, and it stops calling codegraph entirely (observed repeatedly)".
- **Real faults** — missing binary, failed spawn, crash, timeout — throw, so the model sees a tool error instead of plausible-looking text.

This matters more than it sounds. In a 46-session audit of this machine, the only natural `codegraph_explore` call passed the `app.asar` checkout path; 0.8.0 answered `codegraph: spawn ... ENOENT` with `isError: false`, and that session then ran 100+ raw reads without ever retrying CodeGraph.

## System prompt

The plugin ships its own CodeGraph playbook (source: `lib/guide.md`) instead of forwarding the generic MCP server instructions. The upstream text is written for a bare MCP surface — "there is a single tool", "initialization is a terminal command the user runs" — which contradicts a native DSH plugin that registers eleven `codegraph_*` tools and a real `codegraph_init`. Versions 0.5.0-0.6.0 forwarded the upstream text and appended a scope note; 0.7.0 replaced both with one tailored document. The same principle covers tool descriptions: the `codegraph_explore` description is generated from the live tool surface and watcher setting (`exploreDescription` in `lib/guide.js`), so it never references a tool this session did not register.

What survives from the upstream framing:

- the knowledge-graph model and the explore-first rule;
- `codegraph_explore` as Read-equivalent (verbatim, line-numbered source + call paths + blast radius);
- the anti-patterns (don't re-verify with grep, don't reconstruct a flow by hand);
- the staleness banners and how to react to them;
- the limitations (best-effort cross-file resolution, no correctness validation); freshness is stated once, in the live watcher note, so it can never contradict itself.

What is rewritten for DSH:

- the tool inventory is rendered from the live `tools` configuration, so the prompt only advertises the tools that are actually registered;
- the watcher section is rendered from the live resident state (watcher active / reconnecting / gave up / disabled), so the model is told when the index does *not* follow edits;
- the bootstrap rule follows `autoInit`: with it off (the default) the guide says to run `codegraph_init` only when the user asks; with it on the guide says the plugin initializes on first use, so the model is never told to do something the plugin already did.

The section is registered with a dynamic text function, so the rendered guide is rebuilt at every prompt assembly and reflects the current tool surface and watcher state.

## Initialization

By default the plugin does not build any index on its own — it matches the official `codegraph install`, which "wires up agents only". Point the tools at a project and run `codegraph_init` once (it executes `codegraph init -y`); afterwards the resident watcher keeps that index current.

Opt-in automation: set `autoInit: true` on the plugin row and the first query for an unindexed workspace will

1. check for a project marker such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or `pom.xml`;
2. count project files (ignoring `node_modules`, `.git`, `dist`, `build`, etc.) and skip if the count exceeds `maxAutoInitFiles` (default 5000), asking you to run `codegraph_init` explicitly instead;
3. run `codegraph init -y` non-interactively and retry the query.

The first index can take a while. For reference, the workspace this plugin was developed against has a CodeGraph database of about 2.47 GB, with 607 files and 7,934 nodes; budget time and disk space accordingly.

To tune it:

```yaml
- id: dsh-codegraph-plugin
  name: dsh-codegraph-plugin
  config:
    autoInit: false
    maxAutoInitFiles: 5000
    initTimeoutMs: 600000
    queryTimeoutMs: 120000
    syncTimeoutMs: 300000
    maxFiles: 8
    guideSearch: true
    tools: ['explore']        # 'all' or a list to expose more tools
    resident: true
    maxResidentProjects: 3
    residentStartTimeoutMs: 30000
```

## Notes

- Each tool operates on the current session workspace by default. Pass `path` to target another project directory.
- `codegraph_explore` returns source from the index; if a query misses, fall back to the built-in `grep`/`glob`/`read` tools.
- CodeGraph only indexes real directories on disk. Virtual paths (anything inside an `.asar` archive) and paths that do not exist are refused with guidance — use `read`/`grep`/`glob` there.
- `codegraph_init` with `force: true` stops the resident server, rebuilds with `codegraph index --force` (the real "rebuild from scratch" command), then restarts the watcher. The CLI's `init --force` flag only permits home/root paths, so the plugin does not use it for rebuilds.
- The plugin sets `CODEGRAPH_NO_DOWNLOAD=1` for child processes so a missing platform package fails clearly instead of downloading silently.
- CodeGraph is MIT-licensed. See `NOTICE` and the bundled `LICENSE` files.

## Development

```bash
git clone https://github.com/1234fsdc/dsh-codegraph.git
cd dsh-codegraph
npm install --no-save @deepseek-ai/dsh-tools@0.2.2-rc.1 @deepseek-ai/schemastery@3.19.0
npm test
```

The test suite uses `DSH_CODEGRAPH_PACKAGE_ROOT` to point at an existing CodeGraph installation. In production the plugin resolves its own dependency.
