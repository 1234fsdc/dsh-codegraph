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

The resident servers are stopped when the plugin unloads. The CodeGraph daemon itself is shared per project and exits after its idle timeout (CodeGraph default: 5 minutes).

```yaml
- id: dsh-codegraph-plugin
  name: dsh-codegraph-plugin
  config:
    resident: true            # false = CLI-only mode, one process per call
    maxResidentProjects: 3    # LRU limit for simultaneously watched workspaces
    residentStartTimeoutMs: 30000
```

## Official server instructions

Before the first resident MCP handshake the plugin shows its own short fallback guide in the system prompt. Once any `codegraph_*` tool has run in a workspace, the resident server's `initialize` response supplies the official CodeGraph server instructions (~6.7 KB — the exact text the official `codegraph install` injects), and that text replaces the fallback for every later prompt assembly. There is no second copy of the playbook to drift out of date; the section is registered with `interpolate: false` so the forwarded text is never rewritten.

The official text assumes its MCP server is the only surface ("there is a single tool") and has no init tool. This plugin appends a short "DSH integration notes" paragraph scoping those two statements: `codegraph_init` exists as a bootstrap-only extra and must only run when the user asks to enable CodeGraph for an unindexed project.

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
