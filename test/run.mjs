import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runCodegraph, formatOutcome } from '../lib/cli.js'
import { countFiles, isProjectRoot } from '../lib/workspace.js'
import { apply } from '../lib/index.js'
import { probeIndex } from '../lib/readiness.js'
import { listResidents, residentStatus, stopAllResidents } from '../lib/resident.js'
import { renderGuide, staticGuide } from '../lib/guide.js'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


async function stopProjectDaemon(root) {
  try {
    const file = join(root, '.codegraph', 'daemon.pid')
    if (!existsSync(file)) return
    const { pid } = JSON.parse(await readFile(file, 'utf8'))
    if (typeof pid !== 'number') return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    } else {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }
    await sleep(1500)
  } catch {
    // best-effort cleanup only
  }
}

async function cleanupFixture(root) {
  await stopAllResidents()
  await stopProjectDaemon(root)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOTEMPTY') throw error
      await sleep(1000)
    }
  }
}

if (!process.env.DSH_CODEGRAPH_PACKAGE_ROOT) {
  // Prefer the bundled 1.6.2 copy: its initialize response carries the server
  // instructions the passthrough test asserts on (the older global 1.6.0 may not).
  const profileRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@colbymchenry', 'codegraph')
  const globalRoot = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@colbymchenry', 'codegraph')
  process.env.DSH_CODEGRAPH_PACKAGE_ROOT = existsSync(join(profileRoot, 'package.json')) ? profileRoot : globalRoot
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

  const probeStart = process.hrtime.bigint()
  const probed = probeIndex(fixture)
  const probeMs = Number(process.hrtime.bigint() - probeStart) / 1e6
  assert.ok(probed, 'filesystem probe should find the fresh index')
  assert.equal(probed.indexRoot, fixture, 'probe should report the project root')
  assert.ok(probeMs < 50, 'filesystem probe should take well under a millisecond (took ' + probeMs.toFixed(2) + 'ms)')
  assert.equal(probeIndex(fixture + '/src')?.indexRoot, probed.indexRoot, 'probe should walk up from a subdirectory')
  console.log('PASS: filesystem readiness probe finds the index in ' + probeMs.toFixed(2) + 'ms')

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
  apply(ctx, { guideSearch: true, autoInit: false, tools: 'all' })
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

  const defaultSurfaceDefinitions = []
  apply(
    {
      tools: { register(tool) { defaultSurfaceDefinitions.push(tool) } },
      systemPrompt: { section() { return () => {} } },
      workingDirectory: { async ensure() { return fixture } }
    },
    { guideSearch: false }
  )
  assert.deepEqual(
    defaultSurfaceDefinitions.map((tool) => tool.name),
    ['codegraph_init', 'codegraph_explore'],
    'default surface should list only the official explore tool plus the init bootstrap'
  )

  assert.equal(guideSections.length, 1, 'guide section should be registered')
  assert.equal(typeof guideSections[0].text, 'function', 'guide text should be a dynamic provider')
  assert.equal(guideSections[0].interpolate, false, 'passthrough section must not be interpolated')
  const guideBefore = guideSections[0].text()
  assert.match(guideBefore, /codegraph_explore/, 'guide should describe the primary tool')
  assert.match(guideBefore, /This installation \(DeepSeek Harness\)/, 'guide should carry the DSH-specific section')
  assert.doesNotMatch(guideBefore, /\{\{/, 'no template placeholders may survive rendering')
  assert.match(guideBefore, /Additional tools enabled in this session/, 'the "all" surface should be advertised in the guide')
  assert.match(guideBefore, /codegraph_affected/, 'enabled tools should be listed in the guide')

  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: fixture } } } }
  const statusTool = definitions.find((tool) => tool.name === 'codegraph_status')
  const exploreTool = definitions.find((tool) => tool.name === 'codegraph_explore')
  const statusText = await statusTool.execute({}, exec)
  assert.match(statusText, /initialized: true/, 'status tool should report initialized')
  const exploreText = await exploreTool.execute({ query: 'add and multiply' }, exec)
  assert.match(exploreText, /add|multiply/i, 'explore tool should return fixture symbols')

  // The guide is a DSH-tailored playbook rather than a passthrough of the MCP
  // server instructions: it must stay stable across a handshake, advertise only
  // registered tools, and keep the official explore-first framing.
  const guideAfter = guideSections[0].text()
  assert.equal(guideAfter, guideBefore, 'guide text must not change when a resident server connects')
  assert.match(guideAfter, /Read-equivalent/, 'guide should keep the official explore-first framing')
  assert.match(guideAfter, /anti-pattern|Anti-patterns/i, 'guide should keep the anti-pattern section')
  assert.match(guideAfter, /watcher re-indexes edits within about a second/, 'guide should state the resident watcher behaviour')

  const defaultGuide = staticGuide()
  assert.doesNotMatch(defaultGuide, /codegraph_status|codegraph_query|codegraph_affected/, 'the default guide must not advertise tools that are not registered')
  assert.match(defaultGuide, /Only `codegraph_explore` and `codegraph_init`/, 'the default guide should state the actual surface')

  const noResidentGuide = renderGuide({ surface: new Set(['explore']), resident: false, watch: null })
  assert.match(noResidentGuide, /without a resident watcher/, 'resident: false should be reflected in the guide')
  const fatalGuide = renderGuide({ surface: new Set(['explore']), resident: true, watch: { state: 'fatal', lastError: 'boom' } })
  assert.match(fatalGuide, /gave up after repeated failures/, 'a fatal watcher should be reflected in the guide')

  console.log('PASS: plugin registers all tools, executes status + explore, and renders the DSH guide')

  const nodeTool = definitions.find((tool) => tool.name === 'codegraph_node')
  const nodeText = await nodeTool.execute({ file: true, name: 'src/math.js' }, exec)
  assert.match(nodeText, /multiply|add/i, 'codegraph_node file mode should return fixture source')
  const queryTool = definitions.find((tool) => tool.name === 'codegraph_query')
  const queryText = await queryTool.execute({ search: 'multiply' }, exec)
  assert.match(queryText, /multiply/i, 'codegraph_query should return the fixture symbol')
  console.log('PASS: codegraph_node file mode and codegraph_query work')

  const watched = await statusTool.execute({}, exec)
  assert.match(watched, /watch: active/, 'status should report the resident watcher')

  const beforeDelta = await queryTool.execute({ search: 'deltaWidget' }, exec)
  assert.doesNotMatch(beforeDelta, /deltaWidget/, 'new symbol should not be indexed before the edit')
  await writeFile(
    join(src, 'math.js'),
    'export function add(a, b) { return a + b }\n' +
      'export function multiply(a, b) { return a * b }\n' +
      'export function calc(a, b) { return add(a, b) + multiply(a, b) }\n' +
      'export function deltaWidget(a) { return calc(a, 1) }\n'
  )
  let deltaText = ''
  const deltaDeadline = Date.now() + 20000
  while (Date.now() < deltaDeadline) {
    deltaText = await queryTool.execute({ search: 'deltaWidget' }, exec)
    if (/deltaWidget/.test(deltaText)) break
    await sleep(500)
  }
  assert.match(deltaText, /deltaWidget/, 'resident watcher should re-index edits without codegraph_sync')
  console.log('PASS: resident file watcher auto-syncs edits')

  // Crash recovery: killing the MCP launcher must schedule an automatic
  // restart with backoff; the next explore call succeeds against the same
  // detached daemon (the file watcher never stops).
  const beforeCrash = listResidents().find((entry) => entry.root === fixture)
  assert.ok(beforeCrash?.running, 'resident should be running before the crash test')
  assert.ok(beforeCrash.childPid, 'resident should expose the launcher child pid')
  try { process.kill(beforeCrash.childPid) } catch { /* already gone */ }
  let crashStatus = null
  const crashDeadline = Date.now() + 20000
  while (Date.now() < crashDeadline) {
    await sleep(300)
    crashStatus = residentStatus(fixture)
    if (crashStatus.state === 'ready' && crashStatus.running && crashStatus.restarts >= 1) break
  }
  assert.equal(crashStatus?.state, 'ready', 'resident should reconnect automatically after the launcher crashes')
  assert.ok(crashStatus.restarts >= 1, 'restart counter should record the recovery')
  const crashExplore = definitions.find((tool) => tool.name === 'codegraph_explore')
  const crashText = await crashExplore.execute({ query: 'calc function' }, exec)
  assert.match(crashText, /calc|add|multiply/, 'explore should work again after the automatic restart')
  console.log('PASS: resident server restarts automatically after a crash')


  const initTool = definitions.find((tool) => tool.name === 'codegraph_init')
  const rebuild = await initTool.execute({ force: true }, exec)
  assert.match(rebuild, /initialized: true/, 'force rebuild should leave the project initialized')
  assert.match(rebuild, /watch: active/, 'force rebuild should restart the resident watcher')
  console.log('PASS: force rebuild uses codegraph index and restarts the watcher')

  const autoFixture = await mkdtemp(join(tmpdir(), 'dsh-codegraph-plugin-auto-'))
  try {
    assert.equal(probeIndex(autoFixture), null, 'probe should report no index for a fresh directory')
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
    apply(autoCtx, { guideSearch: false, autoInit: true, tools: 'all' })
    const autoExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: autoFixture } } } }
    assert.equal(autoDefinitions.length, 11, 'auto-init context should also register all eleven tools')

    const defaultDefinitions = []
    apply(
      {
        tools: { register(tool) { defaultDefinitions.push(tool) } },
        systemPrompt: { section() { return () => {} } },
        workingDirectory: { async ensure() { return autoFixture } }
      },
      { guideSearch: false }
    )
    const defaultExplore = defaultDefinitions.find((tool) => tool.name === 'codegraph_explore')
    const defaultText = await defaultExplore.execute({ query: 'greet function' }, autoExec)
    assert.match(defaultText, /not initialized/i, 'default config must not auto-init')
    assert.match(defaultText, /codegraph_init/, 'default config should point at codegraph_init')
    const autoExplore = autoDefinitions.find((tool) => tool.name === 'codegraph_explore')
    const autoText = await autoExplore.execute({ query: 'greet function' }, autoExec)
    assert.match(autoText, /greet|shout/i, 'auto-init explore should return fixture symbols')

    const autoStatus = JSON.parse(
      (await runCodegraph(['status', '--json', autoFixture], { cwd: autoFixture, timeoutMs: 30000 })).stdout
    )
    assert.equal(autoStatus.initialized, true, 'auto-init should create an index')
    console.log('PASS: autoInit initializes an unindexed project on first query')
  } finally {
    await cleanupFixture(autoFixture)
  }
} finally {
  await cleanupFixture(fixture)
}
