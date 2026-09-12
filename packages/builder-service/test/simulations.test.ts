import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { MockLanguageModelV4 } from 'ai/test'
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderHandler, createArtifacts, createStore, createSimulations, createTurns, database, migrate, runDesignTurn, runSimulation } from '../src/index.ts'
import { simulationEngine, type SimulationReport } from '../src/simulations.ts'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>, testUrl: string
before(async () => {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; testUrl = url.toString(); pool = database(testUrl); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})
async function prepared() {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: '背景模擬', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' },
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400, model: { kind: 'xyc' },
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
  } })
  const artifacts = createArtifacts(pool, profile), compiled = await artifacts.compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2 })
  const payload = (await artifacts.get(owner, compiled.artifactId)).payload
  const input = { artifactId: compiled.artifactId, draftId: draft.id, expectedRevision: 2 }
  const report: SimulationReport = { schemaVersion: 1, engineVersion: simulationEngine, mode: 'mock', draftId: draft.id, revision: 2,
    artifactDigest: digestJson(payload), manifestHash: payload.manifestHash, passed: true, coverageComplete: true, registrationReady: false,
    cases: [{ name: 'synthetic-worker-fixture', passed: true }] }
  return { account, owner, draft, input, report, payload, conversationId: created.conversationId }
}
const expire = (id: string) => pool.query("UPDATE builder.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id])

test('owned queue inputs deduplicate atomically, reject forged/stale resources and survive repository recreation', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), key = randomUUID()
  const refs = await Promise.all([sims.start(p.owner, key, p.input), sims.start(p.owner, key, p.input), sims.start(p.owner, randomUUID(), p.input)])
  assert.deepEqual(refs[0], refs[1]); assert.deepEqual(refs[0], refs[2])
  assert.equal((await sims.list(p.owner, p.draft.id)).length, 1)
  assert.equal((await createSimulations(pool, profile).get(p.owner, refs[0]!.id)).state, 'pending')
  const other = 'wallet:0x2222222222222222222222222222222222222222'
  await assert.rejects(sims.get(other, refs[0]!.id), /not-found/)
  await assert.rejects(sims.start(other, randomUUID(), p.input), /not-found/)
  await assert.rejects(sims.start(p.owner, randomUUID(), { ...p.input, draftId: 'different-draft' }), /not-found/)
  await assert.rejects(sims.start(p.owner, key, { ...p.input, expectedRevision: 3 }), /idempotency-key-reused/)
  await assert.rejects(sims.start(p.owner, randomUUID(), { ...p.input, rpcUrl: 'http://untrusted.example' }))
  await assert.rejects(pool.query('UPDATE builder.simulation_runs SET engine_version=$2 WHERE id=$1', [refs[0]!.id, 'invented-engine']), /immutable/)
  await sims.cancel(p.owner, randomUUID(), refs[0]!.id)
  assert.equal((await sims.get(p.owner, refs[0]!.id)).state, 'cancelled')
  assert.deepEqual(await sims.start(p.owner, key, p.input), refs[0], 'retrying an accepted receipt cannot silently restart cancelled work')
})

test('competing workers claim separately; expired leases recover without allowing the old worker to commit', async () => {
  const sims = createSimulations(pool, profile), fixtures = [await prepared(), await prepared()]
  for (const p of fixtures) await sims.start(p.owner, randomUUID(), p.input)
  const claims = await Promise.all([sims.claim(), sims.claim()]); assert.ok(claims[0] && claims[1]); assert.notEqual(claims[0].id, claims[1].id)
  for (const claim of claims) {
    assert.ok(claim)
    await sims.finish(claim, fixtures.find(p => p.owner === claim.owner)!.report)
  }
  const p = await prepared(), ref = await sims.start(p.owner, randomUUID(), p.input), first = (await sims.claim())!
  await expire(ref.id)
  await assert.rejects(sims.finish(first, p.report), /lease-lost/)
  const recovered = (await createSimulations(pool, profile).claim())!
  assert.equal(recovered.id, ref.id); assert.equal(recovered.attempt, 2); assert.notEqual(recovered.leaseToken, first.leaseToken)
  await assert.rejects(sims.heartbeat(first), /lease-lost/)
  await assert.rejects(sims.finish(first, p.report), /lease-lost/)
  assert.equal((await sims.input(recovered)).compilation.strategyHash, p.payload.strategyHash)
  await sims.finish(recovered, p.report)
  const result = await createSimulations(pool, profile).get(p.owner, ref.id)
  assert.equal(result.state, 'succeeded'); assert.equal(result.report!.mode, 'mock'); assert.equal(result.registrationReady, false)
  await assert.rejects(pool.query('DELETE FROM builder.simulation_results WHERE run_id=$1', [ref.id]), /immutable/)
  assert.equal((await createSimulations(pool, { ...profile, forwarder: '0x2222222222222222222222222222222222222222' }).get(p.owner, ref.id)).current, false)
})

test('lease expiry while saving evidence rolls back the result and completion event atomically', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), ref = await sims.start(p.owner, randomUUID(), p.input)
  await pool.query(`CREATE SEQUENCE builder.simulation_test_observed;
    CREATE FUNCTION builder.simulation_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('builder.simulation_test_observed'); PERFORM pg_sleep(1.1); RETURN NEW; END; $$;
    CREATE TRIGGER simulation_test_delay BEFORE INSERT ON builder.simulation_results FOR EACH ROW EXECUTE FUNCTION builder.simulation_test_delay()`)
  const claim = (await sims.claim(1000))!
  try {
    await assert.rejects(sims.finish(claim, p.report), /lease-lost/)
    assert.equal((await pool.query('SELECT is_called FROM builder.simulation_test_observed')).rows[0].is_called, true, 'expiry happened during the insert, after the initial lease check')
  } finally { await pool.query('DROP TRIGGER simulation_test_delay ON builder.simulation_results; DROP FUNCTION builder.simulation_test_delay(); DROP SEQUENCE builder.simulation_test_observed') }
  assert.equal((await sims.get(p.owner, ref.id)).report, null)
  assert.equal((await pool.query("SELECT id FROM builder.outbox WHERE resource_id=$1 AND kind='simulation.completed'", [ref.id])).rowCount, 0)
  await sims.finish((await sims.claim())!, p.report)
  assert.equal((await sims.get(p.owner, ref.id)).state, 'succeeded')
})

test('edits invalidate completed evidence and discard in-flight results; cancelled agent authority cannot enqueue work', async () => {
  const sims = createSimulations(pool, profile), store = createStore(pool, profile.id), p = await prepared()
  const done = await sims.start(p.owner, randomUUID(), p.input); await sims.finish((await sims.claim())!, p.report)
  const running = await sims.start(p.owner, randomUUID(), p.input), claim = (await sims.claim())!
  await store.patch(p.owner, randomUUID(), { draftId: p.draft.id, expectedRevision: 2, patch: { spec: { title: '新的需求' } } })
  assert.deepEqual(await sims.finish(claim, p.report), { state: 'cancelled' })
  assert.equal((await sims.get(p.owner, done.id)).current, false)
  assert.ok((await sims.list(p.owner, p.draft.id)).every(r => r.current === false))
  assert.equal((await sims.get(p.owner, running.id)).report, null)
  await assert.rejects(sims.start(p.owner, randomUUID(), p.input), /artifact-stale/)
  const q = await prepared(), turns = createTurns(pool)
  const turn = await turns.accept(q.owner, randomUUID(), { conversationId: q.conversationId, expectedRevision: 2, content: '開始模擬' })
  const lease = (await turns.claim())!; await turns.cancel(q.owner, turn.id)
  await assert.rejects(createSimulations(pool, profile, lease).start(q.owner, randomUUID(), q.input), /agent-turn-stale/)
  assert.equal((await sims.list(q.owner, q.draft.id)).length, 0)
})

test('result binding and status consistency are verified before immutable evidence is committed', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), ref = await sims.start(p.owner, randomUUID(), p.input), claim = (await sims.claim())!
  for (const patch of [{ revision: 3 }, { engineVersion: 'invented-engine' }, { artifactDigest: digestJson('substitution') }, { manifestHash: digestJson('other-profile') },
    { registrationReady: true }, { cases: [{ name: 'actually-failed', passed: false }], passed: true }])
    await assert.rejects(sims.finish(claim, { ...p.report, ...patch }))
  assert.equal((await sims.get(p.owner, ref.id)).report, null)
  await sims.finish(claim, { ...p.report, passed: false, coverageComplete: false, cases: [{ name: 'cannot-settle', passed: false, error: 'InventoryLimitExceeded' }] })
  const result = await sims.get(p.owner, ref.id)
  assert.equal(result.state, 'failed'); assert.equal(result.report!.cases[0]!.error, 'InventoryLimitExceeded')
})

test('background cancellation suppresses late results and worker shutdown preserves a reclaimable lease', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), ref = await sims.start(p.owner, randomUUID(), p.input), claim = (await sims.claim())!
  let started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  const running = runSimulation(pool, profile, async () => { started(); await hold; return p.report }, claim)
  await ready; await sims.cancel(p.owner, randomUUID(), ref.id); release()
  assert.deepEqual(await running, { state: 'incomplete' }); assert.equal((await sims.get(p.owner, ref.id)).report, null)
  const again = await sims.start(p.owner, randomUUID(), p.input), interrupted = (await sims.claim())!
  await runSimulation(pool, profile, async () => { throw new Error('must-not-run') }, interrupted, AbortSignal.abort())
  assert.equal((await sims.get(p.owner, again.id)).state, 'running')
  await expire(again.id)
  await sims.finish((await sims.claim())!, p.report)
  assert.equal((await sims.get(p.owner, again.id)).state, 'succeeded')
})

test('infrastructure failures retry with a bounded budget and expose only a stable error code', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), ref = await sims.start(p.owner, randomUUID(), p.input)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = (await sims.claim())!; assert.equal(claim.attempt, attempt)
    await runSimulation(pool, profile, async () => { throw new Error('provider-detail-must-remain-private') }, claim)
    const result = await sims.get(p.owner, ref.id)
    assert.equal(result.state, attempt < 3 ? 'pending' : 'failed')
    assert.equal(result.errorCode, 'simulation-unavailable'); assert.equal(JSON.stringify(result).includes('provider-detail'), false)
    await pool.query("UPDATE builder.jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1", [ref.id])
  }
  assert.equal(await sims.claim(), null)
})

test('the shared hourly budget counts cancelled attempts without charging duplicate active requests', async () => {
  const p = await prepared(), sims = createSimulations(pool, profile)
  for (let n = 0; n < 12; n++) {
    const ref = await sims.start(p.owner, randomUUID(), p.input)
    assert.deepEqual(await sims.start(p.owner, randomUUID(), p.input), ref)
    await sims.cancel(p.owner, randomUUID(), ref.id)
  }
  await assert.rejects(sims.start(p.owner, randomUUID(), p.input), /simulation-hourly-budget/)
  assert.equal((await sims.list(p.owner, p.draft.id)).length, 12)
})

test('HTTP queues owned artifacts, exposes recoverable status, and accepts neither result uploads nor RPC configuration', async () => {
  const p = await prepared(), other = await prepared(), origin = 'https://pintool.example'
  const config = { origin, chainId: profile.chainId, profileId: profile.id, simulationEnabled: true }
  const handler = builderHandler(pool, config), server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  const call = async (path: string, token?: string, body?: unknown, key = randomUUID()) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const login = async (account: typeof p.account) => {
    const c = await call('/auth/challenge', undefined, { address: account.address })
    return (await call('/auth/login', undefined, { challengeId: c.body.id, signature: await account.signMessage({ message: c.body.message }) })).body.token as string
  }
  try {
    const token = await login(p.account), another = await login(other.account), path = `/artifacts/${p.input.artifactId}/simulations`
    assert.equal((await call(path, undefined, { expectedRevision: 2 })).status, 401)
    assert.equal((await call(path, another, { expectedRevision: 2 })).status, 404)
    assert.equal((await call(path, token, { expectedRevision: 2, rpcUrl: 'http://untrusted.example' })).status, 400)
    const key = randomUUID(), accepted = await call(path, token, { expectedRevision: 2 }, key)
    assert.equal(accepted.status, 202); assert.deepEqual(await call(path, token, { expectedRevision: 2 }, key), accepted)
    const id = accepted.body.id, sims = createSimulations(pool, profile)
    assert.equal((await call(`/simulations/${id}`, another)).status, 404)
    assert.equal((await call(`/simulations/${id}`, token)).body.state, 'pending')
    assert.equal((await call(`/simulations/${id}`, token, { passed: true })).status, 404)
    assert.equal((await call(`/drafts/${p.draft.id}/simulations`, token)).body.simulations[0].current, true)
    await runSimulation(pool, profile, async () => p.report, (await sims.claim())!)
    const done = await call(`/simulations/${id}`, token)
    assert.equal(done.body.state, 'succeeded'); assert.equal(done.body.report.mode, 'mock'); assert.equal(done.body.registrationReady, false)
    config.simulationEnabled = false
    assert.equal((await call(path, token, { expectedRevision: 2 })).status, 503)
    assert.equal((await call(`/simulations/${id}`, token)).body.state, 'succeeded', 'disabling new work preserves status reads')
    assert.equal((await call(`/simulations/${id}/cancel`, token, {})).body.state, 'succeeded')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('AI SDK simulation tool enqueues through scoped authority without claiming a completed fork', async () => {
  const p = await prepared(), turns = createTurns(pool), sims = createSimulations(pool, profile)
  const turn = await turns.accept(p.owner, randomUUID(), { conversationId: p.conversationId, content: '開始背景模擬，先不要做錢包交易。', expectedRevision: 2 })
  let step = 0
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] })
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: 'inspect', toolName: 'inspectStrategy', input: JSON.stringify({ view: 'current' }) })
    else if (step === 1) c.enqueue({ type: 'tool-call', toolCallId: 'simulate', toolName: 'simulateLifecycle', input: JSON.stringify({ artifactId: p.input.artifactId, expectedRevision: 2 }) })
    else {
      c.enqueue({ type: 'text-start', id: 'reply' }); c.enqueue({ type: 'text-delta', id: 'reply', delta: '已排入背景模擬，結果尚未完成。' }); c.enqueue({ type: 'text-end', id: 'reply' })
    }
    c.enqueue({ type: 'finish', finishReason: { unified: step++ < 2 ? 'tool-calls' : 'stop', raw: undefined }, usage }); c.close()
  } }) }) })
  await runDesignTurn(pool, profile, model, (await turns.claim())!, undefined, { simulationEnabled: true })
  const jobs = await sims.list(p.owner, p.draft.id)
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.state, 'pending'); assert.equal(jobs[0]!.passed, null)
  assert.ok((await turns.events(p.owner, turn.id)).some(e => e.kind === 'tool' && e.payload.name === 'simulateLifecycle' && e.payload.ok))
  await sims.cancel(p.owner, randomUUID(), jobs[0]!.id)
})

test('optional real fork is persisted by a separate worker process, separately from mock queue evidence', {
  skip: !process.env.BUILDER_FORK_RPC_URL, timeout: 360000,
}, async () => {
  const p = await prepared(), sims = createSimulations(pool, profile), ref = await sims.start(p.owner, randomUUID(), p.input)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/simulation-main.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: testUrl, ANVIL: process.env.ANVIL,
      BUILDER_SIMULATION_ENABLED: 'true', BUILDER_SIMULATION_RPC_URL: process.env.BUILDER_FORK_RPC_URL }, stdio: ['ignore','pipe','pipe'],
  })
  let logs = '', unavailable = false
  child.stdout.on('data', chunk => { logs += String(chunk) }); child.stderr.on('data', chunk => { logs += String(chunk) })
  child.once('error', () => { unavailable = true }); child.once('exit', () => { unavailable = true })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    const until = Date.now() + 330000
    for (;;) {
      assert.equal(unavailable, false)
      const state = await sims.get(p.owner, ref.id)
      if (['succeeded','failed'].includes(state.state)) break
      assert.ok(Date.now() < until, 'worker completion budget'); await delay(500)
    }
    const result = await createSimulations(pool, profile).get(p.owner, ref.id)
    assert.equal(result.state, 'succeeded'); assert.equal(result.current, true)
    assert.equal(result.report!.mode, 'fork-with-overrides'); assert.equal(result.report!.cases.length, 25)
    assert.equal(result.registrationReady, false); assert.ok(logs.includes('simulation-worker-started'))
  } finally { child.kill('SIGTERM'); await closed }
})
