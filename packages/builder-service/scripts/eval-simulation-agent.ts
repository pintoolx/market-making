import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderSimulationFixture } from '../../../contracts/aqua-executor/scripts/builder-simulation-fixture.ts'
import { database, migrate, builderHandler, createTurns, runDesignTurn, openAIModel } from '../src/index.ts'

// Real OpenAI + signed local HTTP + separate fork worker. This identity has no public funds.
const account = privateKeyToAccount(generatePrivateKey()), name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
const origin = 'https://pintool-eval.example', modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
let pool: ReturnType<typeof database> | undefined, admin: ReturnType<typeof database> | undefined, server: ReturnType<typeof createServer> | undefined
let worker: ChildProcess | undefined, workerClosed: Promise<void> | undefined, workerUnavailable = false
const evidence: unknown[] = [], directory = new URL('../../../.cache/builder/', import.meta.url)
try {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'local disposable database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id, designEnabled: true, simulationEnabled: true })
  server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  let token: string | undefined
  const call = async (path: string, body?: unknown, key = randomUUID()) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      origin, 'content-type': 'application/json', 'idempotency-key': key, ...(token ? { authorization: 'Bearer ' + token } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `HTTP ${response.status}`)
    return await response.json() as any
  }
  const challenge = await call('/auth/challenge', { address: account.address })
  token = (await call('/auth/login', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) })).token
  const created = await call('/conversations', { title: '模擬失敗與多輪修正', kind: 'maker' })
  const fixture = builderSimulationFixture('xyc', account.address.toLowerCase()), { profileId: _profileId, ...spec } = fixture.spec
  await call(`/drafts/${created.draft.id}/patch`, { expectedRevision: 1, patch: { spec, allocations: fixture.allocations } })
  const turns = createTurns(pool), model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  worker = spawn(process.execPath, [fileURLToPath(new URL('../src/simulation-main.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url.toString(), ANVIL: process.env.ANVIL,
      BUILDER_SIMULATION_ENABLED: 'true', BUILDER_SIMULATION_RPC_URL: process.env.BUILDER_FORK_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
    stdio: 'ignore',
  })
  worker.once('error', () => { workerUnavailable = true }); worker.once('exit', () => { workerUnavailable = true })
  workerClosed = new Promise<void>(resolve => worker!.once('close', () => resolve()))
  const prompts = [
    '請檢查目前這份已填妥的 Maker 草稿，保留所有設定，編譯並排入背景 lifecycle 模擬。排隊完成先回報，不要把 job ID 當成通過或正式上線。',
    '請讀取剛才的模擬结果。這是不是表示已經正式上線或收到 CRE 授權？先不要改設定或再排一次工作。',
    '這是本地極小額壓力測試：只把 WETH 單筆上限改成 0.000000000000000001 WETH，其它配置、caps、曲線、零費率與期限保持不變。請保存、重新編譯並排入背景模擬，檢查到底能否成交。',
    '請先看剛才的失敗原因，再把 WETH 單筆上限恢復為 0.005 WETH，其它全部不變。保存、重新編譯並排入新的背景模擬，不要使用過期結果。',
    '讀取最新模擬結果，用容易理解的中文說明這次測試範圍，以及剛才極小上限失敗有哪些可能原因。請區分觀察到的事實與推測，不要列長 ID，不要改設定或再排工作。',
  ]
  await mkdir(directory, { recursive: true })
  for (const [index, content] of prompts.entries()) {
    const before = (await call(`/drafts/${created.draft.id}`)).draft
    const accepted = await call(`/conversations/${created.conversationId}/turns`, { content, expectedRevision: before.revision })
    console.log(JSON.stringify({ turn: index + 1, state: 'model-running' }))
    const claimed = (await turns.claim())!; assert.equal(claimed.turnId, accepted.id)
    await runDesignTurn(pool, profile, model, claimed, undefined, { simulationEnabled: true })
    const turn = (await call(`/turns/${accepted.id}`)).turn
    assert.equal(turn.state, 'succeeded')
    const events = (await call(`/turns/${accepted.id}/events`)).events
    const reply = (await call(`/conversations/${created.conversationId}/messages`)).messages.find((m: any) => m.id === turn.messageId)?.content
    assert.ok(reply)
    const draft = (await call(`/drafts/${created.draft.id}`)).draft
    const cap = index === 2 ? '1' : '5000000000000000'
    assert.deepEqual(draft.spec.guardEnvelope, { ...fixture.spec.guardEnvelope, maxAmountBasePerSwap: cap })
    assert.deepEqual(draft.allocations, fixture.allocations); assert.deepEqual(draft.spec.model, fixture.spec.model)
    assert.equal(draft.spec.deadline, fixture.spec.deadline); assert.equal(draft.spec.feeBps, 0)
    if (index === 1 || index === 4) assert.deepEqual(draft, before)
    else assert.ok(events.some((e: any) => e.kind === 'tool' && e.payload.name === 'simulateLifecycle' && e.payload.ok), 'actual simulation tool must queue work')
    const rows = (await call(`/drafts/${draft.id}/simulations`)).simulations
    const current = rows.find((r: any) => r.current)
    assert.ok(current, 'current simulation reference required')
    console.log(JSON.stringify({ turn: index + 1, state: 'waiting-for-fork', reply: reply.slice(0, 800) }))
    const until = Date.now() + 330000
    let simulation
    do {
      assert.equal(workerUnavailable, false, 'separate worker remains available')
      simulation = await call(`/simulations/${current.id}`)
      if (['succeeded','failed','cancelled'].includes(simulation.state)) break
      assert.ok(Date.now() < until, 'simulation completion budget'); await delay(500)
    } while (true)
    const artifacts = await Promise.all((await call(`/drafts/${draft.id}/artifacts`)).artifacts.map((a: any) => call(`/artifacts/${a.artifactId}`)))
    evidence.push({ turn: index + 1, content, reply, draft, events, simulation, artifacts })
    await writeFile(new URL('live-simulation-agent-eval.json', directory), JSON.stringify({ modelId, recordedAt: new Date().toISOString(),
      mode: 'authenticated-http-agent-and-separate-fork-worker', evidence }, null, 2) + '\n')
    assert.equal(simulation.state, index === 2 ? 'failed' : 'succeeded')
    assert.equal(simulation.report.mode, 'fork-with-overrides'); assert.equal(simulation.report.passed, index !== 2)
    assert.equal(simulation.current, true); assert.equal(simulation.registrationReady, false)
    assert.equal(artifacts.filter(a => a.current).length, 1)
    if (index >= 2) assert.ok(artifacts.some(a => !a.current))
    console.log(JSON.stringify({ turn: index + 1, state: 'passed', simulation: simulation.state, revision: draft.revision }))
  }
  console.log(JSON.stringify({ result: 'passed', turns: prompts.length, modelId, publicChainWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', type: error instanceof Error ? error.name : 'unknown',
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : undefined }))
  process.exitCode = 1
} finally {
  if (worker) { worker.kill('SIGTERM'); await workerClosed }
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
}
