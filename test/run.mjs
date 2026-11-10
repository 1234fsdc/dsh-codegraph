import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runCodegraph, formatOutcome } from '../lib/cli.js'
import { countFiles, isProjectRoot } from '../lib/workspace.js'
import { apply } from '../lib/index.js'

if (!process.env.DSH_CODEGRAPH_PACKAGE_ROOT) {
  process.env.DSH_CODEGRAPH_PACKAGE_ROOT = join(
    homedir(),
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    '@colbymchenry',
    'codegraph'
  )
}

const fixture = await mkdtemp(join(tmpdir(), 'dsh-codegraph-plugin-'))
const src = join(fixture, 'src')
await mkdir(src, { recursive: true })
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
await writeFile(
  join(src, 'math.js'),
  'export function add(a, b) { return a + b }\nexport function multiply(a, b) { return a * b }\nexport function calc(a, b) { return add(a, b) + multiply(a, b) }\n'
)

try {
  assert.equal(await isProjectRoot(fixture), true, 'fixture should look like a project')
  assert.ok((await countFiles(fixture, 100)) >= 2, 'fixture should contain files')

  const before = await runCodegraph(['status', '--json', fixture], { cwd: fixture, timeoutMs: 30000 })
  assert.equal(before.code, 0, 'status should exit 0: ' + formatOutcome(before))
  const beforeInfo = JSON.parse(before.stdout)
  assert.equal(beforeInfo.initialized, false, 'fresh fixture should not be initialized')

  const init = await runCodegraph(['init', '-y', fixture], { cwd: fixture, timeoutMs: 120000 })
  assert.equal(init.code, 0, 'init should exit 0: ' + formatOutcome(init))

  const after = await runCodegraph(['status', '--json', fixture], { cwd: fixture, timeoutMs: 30000 })
  const afterInfo = JSON.parse(after.stdout)
  assert.equal(afterInfo.initialized, true, 'fixture should be initialized')
  assert.ok(afterInfo.fileCount >= 1, 'fileCount should be >= 1')

  const explore = await runCodegraph(
    ['explore', '--path', fixture, '--max-files', '2', 'add and multiply functions'],
    { cwd: fixture, timeoutMs: 120000 }
  )
  assert.equal(explore.code, 0, 'explore should exit 0: ' + formatOutcome(explore))
  assert.match(explore.stdout, /multiply|add/i, 'explore output should mention the fixture symbols')

  const sync = await runCodegraph(['sync', fixture], { cwd: fixture, timeoutMs: 120000 })
  assert.equal(sync.code, 0, 'sync should exit 0: ' + formatOutcome(sync))

  console.log('PASS: cli status/init/explore/sync and workspace helpers')
  console.log('status:', afterInfo.fileCount, 'files,', afterInfo.nodeCount, 'nodes,', afterInfo.edgeCount, 'edges')

  const definitions = []
  const guideSections = []
  const ctx = {
    tools: { register(tool) { definitions.push(tool) } },
    systemPrompt: { section(section) { guideSections.push(section); return () => {} } },
    workingDirectory: { async ensure() { return fixture } }
  }
  apply(ctx, { guideSearch: true, autoInit: false })
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    [
      'codegraph_status',
      'codegraph_init',
      'codegraph_sync',
      'codegraph_explore',
      'codegraph_query',
      'codegraph_node',
      'codegraph_files',
      'codegraph_callers',
      'codegraph_callees',
      'codegraph_impact',
      'codegraph_affected'
    ],
    'plugin should register all eleven tools by default'
  )
  assert.equal(guideSections.length, 1, 'guide section should be registered')
  assert.match(guideSections[0].text, /codegraph_explore/)

  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: fixture } } } }
  const statusTool = definitions.find((tool) => tool.name === 'codegraph_status')
  const exploreTool = definitions.find((tool) => tool.name === 'codegraph_explore')
  const statusText = await statusTool.execute({}, exec)
  assert.match(statusText, /initialized: true/, 'status tool should report initialized')
  const exploreText = await exploreTool.execute({ query: 'add and multiply' }, exec)
  assert.match(exploreText, /add|multiply/i, 'explore tool should return fixture symbols')

  console.log('PASS: plugin registers all tools and executes status + explore')

  const nodeTool = definitions.find((tool) => tool.name === 'codegraph_node')
  const nodeText = await nodeTool.execute({ file: true, name: 'src/math.js' }, exec)
  assert.match(nodeText, /multiply|add/i, 'codegraph_node file mode should return fixture source')
  const queryTool = definitions.find((tool) => tool.name === 'codegraph_query')
  const queryText = await queryTool.execute({ search: 'multiply' }, exec)
  assert.match(queryText, /multiply/i, 'codegraph_query should return the fixture symbol')
  console.log('PASS: codegraph_node file mode and codegraph_query work')

  const autoFixture = await mkdtemp(join(tmpdir(), 'dsh-codegraph-plugin-auto-'))
  try {
    await mkdir(join(autoFixture, 'src'), { recursive: true })
    await writeFile(join(autoFixture, 'package.json'), JSON.stringify({ name: 'auto-fixture', version: '1.0.0' }))
    await writeFile(
      join(autoFixture, 'src', 'greet.js'),
      'export function greet(name) { return "hello " + name }\nexport function shout(name) { return greet(name).toUpperCase() }\n'
    )

    const autoDefinitions = []
    const autoCtx = {
      tools: { register(tool) { autoDefinitions.push(tool) } },
      systemPrompt: { section() { return () => {} } },
      workingDirectory: { async ensure() { return autoFixture } }
    }
    apply(autoCtx, { guideSearch: false, autoInit: true })
    const autoExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: autoFixture } } } }
    assert.equal(autoDefinitions.length, 11, 'auto-init context should also register all eleven tools')
    const autoExplore = autoDefinitions.find((tool) => tool.name === 'codegraph_explore')
    const autoText = await autoExplore.execute({ query: 'greet function' }, autoExec)
    assert.match(autoText, /greet|shout/i, 'auto-init explore should return fixture symbols')

    const autoStatus = JSON.parse(
      (await runCodegraph(['status', '--json', autoFixture], { cwd: autoFixture, timeoutMs: 30000 })).stdout
    )
    assert.equal(autoStatus.initialized, true, 'auto-init should create an index')
    console.log('PASS: autoInit initializes an unindexed project on first query')
  } finally {
    await rm(autoFixture, { recursive: true, force: true })
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}
