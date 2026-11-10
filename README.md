# dsh-codegraph

Native [CodeGraph](https://github.com/colbymchenry/codegraph) tools for DeepSeek Harness. The npm package is `dsh-codegraph-plugin`; the project repository is [dsh-codegraph](https://github.com/1234fsdc/dsh-codegraph).

`dsh-codegraph-plugin` turns the CodeGraph CLI into native DSH tools. It bundles `@colbymchenry/codegraph@1.6.2`, so installing the plugin is enough — you do not need a global `codegraph` command.

## Install

From GitHub:

```bash
dsh plugin --profile desktop add -w --save-exact github:1234fsdc/dsh-codegraph
```

Pin a release with `github:1234fsdc/dsh-codegraph#v0.2.0`.

From a release tarball:

```bash
dsh plugin --profile desktop add -w --save-exact /absolute/path/to/dsh-codegraph-plugin-0.2.0.tgz
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

All tools are registered by default:

| Tool | What it does |
| --- | --- |
| `codegraph_status` | Show whether the current project has a CodeGraph index and print counts. |
| `codegraph_init` | Build the first index (creates `.codegraph/`); pass `force: true` to rebuild. |
| `codegraph_sync` | Incrementally update the index after edits. |
| `codegraph_explore` | Return relevant symbols' verbatim source plus call paths in one shot. |
| `codegraph_query` | Search symbols by name and return matching nodes as JSON. |
| `codegraph_node` | Show one symbol with its caller/callee trail, or read a file with line numbers. |
| `codegraph_files` | Show the indexed file structure with language and symbol metadata. |
| `codegraph_callers` | Find functions/methods that call a symbol. |
| `codegraph_callees` | Find functions/methods a symbol calls. |
| `codegraph_impact` | Analyze what code is affected by changing a symbol. |
| `codegraph_affected` | Find test files affected by changed source files. |

## Resident index watcher

Starting with 0.2.0 the plugin keeps one CodeGraph MCP server alive per workspace, the same architecture the official `codegraph install` uses. The MCP launcher owns a detached CodeGraph daemon with a file watcher, a single SQLite connection and a warm query pool. As a result:

- Edits are re-indexed automatically within about a second; `codegraph_sync` is only a manual fallback.
- `codegraph_explore` is served over MCP instead of starting a CLI process per call. On the reference 2.47 GB / 607-file workspace a warm MCP explore took about 0.2 s versus about 1.1 s for a cold CLI run.
- Startup happens lazily on the first tool call for a workspace and costs a few hundred milliseconds. The watcher uses roughly 150 MB of memory per active workspace.

The resident servers are stopped when the plugin unloads. The CodeGraph daemon itself is shared per project and exits after its idle timeout (CodeGraph default: 5 minutes).

```yaml
- id: dsh-codegraph-plugin
  name: dsh-codegraph-plugin
  config:
    resident: true            # false = CLI-only mode, one process per call
    maxResidentProjects: 3    # LRU limit for simultaneously watched workspaces
    residentStartTimeoutMs: 30000
```

## Automatic initialization

`autoInit` is enabled by default. On the first query for an unindexed workspace:

1. The plugin checks for a project marker such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or `pom.xml`.
2. It counts project files (ignoring `node_modules`, `.git`, `dist`, `build`, etc.). If the count exceeds `maxAutoInitFiles` (default 5000), it asks you to run `codegraph_init` explicitly instead.
3. It runs `codegraph init -y` non-interactively and then retries the query.

The first index can take a while. For reference, the workspace this plugin was developed against has a CodeGraph database of about 2.47 GB, with 607 files and 7,934 nodes; budget time and disk space accordingly.

To disable automatic initialization, set `autoInit: false` on the plugin row. To tune it:

```yaml
- id: dsh-codegraph-plugin
  name: dsh-codegraph-plugin
  config:
    autoInit: true
    maxAutoInitFiles: 5000
    initTimeoutMs: 600000
    queryTimeoutMs: 120000
    syncTimeoutMs: 300000
    maxFiles: 8
    guideSearch: true
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
