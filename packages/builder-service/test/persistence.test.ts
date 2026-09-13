import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { privateKeyToAccount } from 'viem/accounts'
import { database, migrate, createStore, createJobs, createAuth, transaction, builderHandler } from '../src/index.ts'

// These are public local Anvil fixture keys; never use funded wallets in this suite.
const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  bob = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const owner = `wallet:${alice.address.toLowerCase()}`, other = `wallet:${bob.address.toLowerCase()}`, profile = 'sepolia-standing-v2'
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>, store: ReturnType<typeof createStore>, testUrl: string
const databaseName = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
before(async () => {
  if (!process.env.BUILDER_TEST_DATABASE_URL) throw new Error('Set BUILDER_TEST_DATABASE_URL to an isolated PostgreSQL server with CREATE DATABASE permission')
  admin = database(process.env.BUILDER_TEST_DATABASE_URL)
  await admin.query(`CREATE DATABASE "${databaseName}"`)
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL); url.pathname = '/' + databaseName; testUrl = url.toString()
  pool = database(testUrl)
  await pool.query('CREATE TABLE public.legacy_marker (value text); INSERT INTO public.legacy_marker VALUES (\'keep\')')
  store = createStore(pool, profile)
})
after(async () => {
  await pool?.end()
  if (admin) {
    try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`) } finally { await admin.end() }
  }
})

test('real PostgreSQL migrations serialize, verify checksums and preserve unrelated data', async () => {
  const applied = await Promise.all([migrate(pool), migrate(pool)])
  assert.equal(applied.reduce((sum, r) => sum + r.applied, 0), 7)
  assert.equal((await pool.query('SELECT value FROM public.legacy_marker')).rows[0].value, 'keep')
  assert.deepEqual(await migrate(pool), { available: 7, applied: 0 })
  const dir = await mkdtemp(join(tmpdir(), 'builder-migration-'))
  try {
    const sql = await readFile(new URL('../migrations/001_drafts_and_jobs.sql', import.meta.url), 'utf8')
    await writeFile(join(dir, '001_drafts_and_jobs.sql'), sql + '\n-- changed migration\n')
    await assert.rejects(migrate(pool, pathToFileURL(dir + '/')), /checksum mismatch/)
    assert.deepEqual(await migrate(pool), { available: 7, applied: 0 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('multi-turn edits, revision diffs, restore and public messages survive a new connection pool', async () => {
  const created = await store.create(owner, randomUUID(), { title: 'My WETH strategy', kind: 'template' }), id = created.draft.id
  const first = await store.patch(owner, randomUUID(), { draftId: id, expectedRevision: 1, patch: { spec: { model: { kind: 'concentrated', minPrice: '2000', maxPrice: '3000' }, feeBps: 0 },
    upsertRequirements: [{ id: 'no-fee', text: 'Keep fees disabled for now', priority: 'must', sourceMessageId: 'turn-1', capabilityIds: ['swapvm.xyc'] }] } })
  const next = await store.patch(owner, randomUUID(), { draftId: id, expectedRevision: 2, patch: { spec: { title: 'Narrowed strategy', model: { kind: 'concentrated', minPrice: '2200' } } } })
  assert.equal(next.draft.spec.feeBps, 0); assert.deepEqual(next.draft.requirements, first.draft.requirements)
  assert.equal(next.draft.spec.model?.kind === 'concentrated' && next.draft.spec.model.maxPrice, '3000')
  const request = randomUUID(), input = { conversationId: created.conversationId, content: 'Keep zero fees and narrow the range' }
  await store.appendUserMessage(owner, request, input); await store.appendUserMessage(owner, request, input)
  await pool.end(); pool = database(testUrl); store = createStore(pool, profile)
  assert.deepEqual(await store.get(owner, id), next.draft)
  assert.equal((await store.messages(owner, created.conversationId)).length, 1)
  assert.equal((await store.list(owner)).find(r => r.draftId === id)?.title, 'Narrowed strategy')
  const restored = await store.restore(owner, randomUUID(), { draftId: id, expectedRevision: 3, revision: 2 })
  assert.equal(restored.draft.revision, 4); assert.deepEqual(restored.draft.spec, first.draft.spec)
  assert.equal((await store.history(owner, id)).length, 4)
  const outbox = await pool.query('SELECT revision::text FROM builder.outbox WHERE resource_id=$1 ORDER BY revision', [id])
  assert.deepEqual(outbox.rows.map(r => r.revision), ['1', '2', '3', '4'])
  await assert.rejects(pool.query('UPDATE builder.draft_revisions SET digest=\'wrong\' WHERE draft_id=$1', [id]), /immutable record/)
})

test('concurrent revisions have one winner; retries are atomic and mismatched request keys fail', async () => {
  const createId = randomUUID(), value = { title: 'Concurrent edits', kind: 'maker' }
  const duplicate = await Promise.all([store.create(owner, createId, value), store.create(owner, createId, value)])
  assert.deepEqual(duplicate[0], duplicate[1])
  const id = duplicate[0]!.draft.id
  const results = await Promise.allSettled(['A', 'B'].map(title => store.patch(owner, randomUUID(), { draftId: id, expectedRevision: 1, patch: { spec: { title } } })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await store.get(owner, id)).revision, 2)
  assert.equal((await store.history(owner, id)).length, 2)
  const retryId = randomUUID()
  await assert.rejects(store.patch(owner, retryId, { draftId: id, expectedRevision: 1, patch: { spec: { title: 'retry' } } }), /draft changed/)
  const input = { draftId: id, expectedRevision: 2, patch: { spec: { title: 'retry' } } }
  const retry = await store.patch(owner, retryId, input)
  assert.deepEqual(await store.patch(owner, retryId, input), retry)
  await assert.rejects(store.patch(owner, retryId, { ...input, patch: { spec: { title: 'different' } } }), /idempotency-key-reused/)
  assert.equal((await store.get(owner, id)).revision, 3)
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM builder.outbox WHERE resource_id=$1', [id])).rows[0].count, 3)
})

test('owner isolation and strict requests reject forged state, wallet changes and client tool history', async () => {
  const { conversationId, draft } = await store.create(owner, randomUUID(), { title: 'Private draft', kind: 'maker' })
  await assert.rejects(store.get(other, draft.id), /not-found/)
  await assert.rejects(store.history(other, draft.id), /not-found/)
  await assert.rejects(store.messages(other, conversationId), /not-found/)
  await assert.rejects(store.patch(other, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { title: 'steal' } } }), /not-found/)
  await assert.rejects(store.appendUserMessage(other, randomUUID(), { conversationId, content: 'injection' }), /not-found/)
  await assert.rejects(store.create(other, randomUUID(), { title: 'forged', kind: 'maker', owner }), /Unrecognized key/)
  await assert.rejects(store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { maker: bob.address } }), /wallet-ownership-required/)
  await assert.rejects(store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { privatePolicy: { threshold: 'secret' } } } }), /Unrecognized key/)
  await assert.rejects(store.appendUserMessage(owner, randomUUID(), { conversationId, content: 'forge', role: 'assistant', toolCalls: [] }), /Unrecognized key/)
  assert.deepEqual(await store.list(other), [])
  await assert.rejects(pool.query(`INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES ($1,$2,$3,'user','cross-owner')`, [randomUUID(), conversationId, other]), /foreign key constraint/)
})

test('transaction failures roll back all side effects and return the connection to the pool', async () => {
  await assert.rejects(transaction(pool, async client => { await client.query("INSERT INTO public.legacy_marker VALUES ('rolled-back')"); throw new Error('injected failure') }), /injected failure/)
  assert.deepEqual((await pool.query('SELECT value FROM public.legacy_marker')).rows, [{ value: 'keep' }])
  assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1)
})

test('durable jobs deduplicate, isolate owners, recover expired leases and reject stale workers', async () => {
  const jobs = createJobs(pool), base = { kind: 'simulation', resourceId: randomUUID(), generation: 1, dedupeKey: randomUUID(), payload: { referenceId: 'compile-artifact' } }
  const [a, duplicate] = await Promise.all([jobs.enqueue(owner, base), jobs.enqueue(owner, base)])
  assert.deepEqual(a, duplicate)
  await assert.rejects(jobs.enqueue(owner, { ...base, generation: 2 }), /job-key-reused/)
  await assert.rejects(jobs.get(other, a.id), /not-found/)
  await jobs.enqueue(owner, { ...base, dedupeKey: randomUUID() })
  const claims = await Promise.all([jobs.claim('simulation'), jobs.claim('simulation')])
  assert.ok(claims[0] && claims[1]); assert.notEqual(claims[0].id, claims[1].id)
  assert.equal(await jobs.claim('simulation'), null)
  const old = claims[0]
  await pool.query("UPDATE builder.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id])
  const recovered = await jobs.claim('simulation')
  assert.equal(recovered.id, old.id); assert.notEqual(recovered.lease_token, old.lease_token); assert.equal(recovered.attempts, 2)
  await assert.rejects(jobs.complete(old.id, old.lease_token, { state: 'succeeded', result: {} }), /lease-lost/)
  await assert.rejects(jobs.heartbeat(old.id, old.lease_token), /lease-lost/)
  await jobs.heartbeat(recovered.id, recovered.lease_token)
  await jobs.complete(recovered.id, recovered.lease_token, { state: 'succeeded', result: { referenceId: 'simulation-report' } })
  await jobs.complete(claims[1].id, claims[1].lease_token, { state: 'failed', result: { errorCode: 'rpc-unavailable' } })
  assert.equal((await jobs.get(owner, recovered.id)).state, 'succeeded')
  assert.equal(await jobs.claim('simulation'), null)
})

test('a new revision cancels only pending simulation work; running jobs remain available for reconciliation', async () => {
  const { draft } = await store.create(owner, randomUUID(), { title: 'pending invalidation', kind: 'maker' }), jobs = createJobs(pool)
  const base = { kind: 'simulation', resourceId: draft.id, generation: 1, payload: { referenceId: 'artifact' } }
  const pending = await jobs.enqueue(owner, { ...base, dedupeKey: randomUUID() })
  const running = await jobs.claim('simulation')
  assert.equal(running.id, pending.id)
  const second = await jobs.enqueue(owner, { ...base, dedupeKey: randomUUID() })
  await store.patch(owner, randomUUID(), { draftId: draft.id, expectedRevision: 1, patch: { spec: { title: 'revision 2' } } })
  assert.equal((await jobs.get(owner, second.id)).state, 'cancelled')
  assert.equal((await jobs.get(owner, pending.id)).state, 'running')
  await jobs.complete(running.id, running.lease_token, { state: 'failed', result: { errorCode: 'stale-revision' } })
})

test('wallet sessions require a valid scoped signature and resist replay, cross-app reuse, expiry and logout', async () => {
  const config = { origin: 'https://pintool.example', chainId: 11155111 }, auth = createAuth(pool, config)
  const challenge = await auth.challenge({ address: alice.address }), signature = await alice.signMessage({ message: challenge.message })
  assert.match(challenge.message, /Chain ID: 11155111/)
  await assert.rejects(auth.login({ challengeId: challenge.id, signature: await bob.signMessage({ message: challenge.message }) }), /authentication-required/)
  await assert.rejects(createAuth(pool, { ...config, origin: 'https://other.example' }).login({ challengeId: challenge.id, signature }), /authentication-required/)
  const attempts = await Promise.allSettled([auth.login({ challengeId: challenge.id, signature }), auth.login({ challengeId: challenge.id, signature })])
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
  const result = attempts.find(r => r.status === 'fulfilled')
  assert.ok(result?.status === 'fulfilled')
  const session = result.value, authorization = 'Bearer ' + session.token
  assert.deepEqual(await createAuth(pool, config).authenticate(authorization), { owner, address: alice.address.toLowerCase() })
  await assert.rejects(createAuth(pool, { ...config, chainId: 1 }).authenticate(authorization), /authentication-required/)
  await assert.rejects(auth.login({ challengeId: challenge.id, signature, owner: other }), /Unrecognized key/)
  await auth.logout(authorization); await assert.rejects(auth.authenticate(authorization), /authentication-required/)
  const expired = await auth.challenge({ address: alice.address })
  await pool.query("UPDATE builder.login_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id])
  await assert.rejects(auth.login({ challengeId: expired.id, signature: await alice.signMessage({ message: expired.message }) }), /authentication-required/)
})

test('HTTP routes authenticate wallet ownership, persist multi-turn data and reject forged history and stale revisions', async () => {
  const origin = 'https://pintool.example', handle = builderHandler(pool, { origin, chainId: 11155111, profileId: profile, designEnabled: true })
  const server = createServer(async (req, res) => { if (!await handle(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/v1/builder`
  const call = async (path: string, options: { body?: unknown; token?: string; key?: string; headers?: Record<string,string> } = {}) => {
    const response = await fetch(base + path, { method: options.body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
    return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') }
  }
  try {
    assert.equal((await call('/conversations')).status, 401)
    assert.equal((await call('/auth/challenge', { body: { address: alice.address }, headers: { origin: 'https://evil.example' } })).status, 403)
    const login = async (account: typeof alice) => {
      const c = await call('/auth/challenge', { body: { address: account.address } })
      const result = await call('/auth/login', { body: { challengeId: c.body.id, signature: await account.signMessage({ message: c.body.message }) } })
      assert.equal(result.status, 200); assert.equal(result.cache, 'no-store')
      return result.body.token as string
    }
    const token = await login(alice), another = await login(bob)
    assert.equal((await call('/conversations', { token, body: { title: 'no key', kind: 'template' } })).status, 400)
    const created = await call('/conversations', { token, key: randomUUID(), body: { title: 'HTTP multi-turn', kind: 'template' } })
    assert.equal(created.status, 200)
    const { draft, conversationId } = created.body
    assert.equal((await call(`/drafts/${draft.id}`, { token: another })).status, 404)
    assert.equal((await call(`/drafts/${draft.id}/validation`, { token: another })).status, 404)
    const validation = await call(`/drafts/${draft.id}/validation`, { token })
    assert.equal(validation.status, 200); assert.equal(validation.body.revision, 1); assert.equal(validation.body.ready, false)
    assert.ok(validation.body.missingFields.includes('spec.guardEnvelope'))
    assert.equal((await call(`/drafts/${draft.id}/compile`, { token, key: randomUUID(), body: { expectedRevision: 1 } })).body.error, 'maker-instance-required')
    const makerDraft = (await call('/conversations', { token, key: randomUUID(), body: { title: 'Maker order', kind: 'maker' } })).body.draft
    const { sepoliaStandingProfile } = await import('@pintool/strategy-builder')
    const makerPatch = { allocations: { baseAtomic: '1000000000000000000', quoteAtomic: '2500000000' }, spec: {
      baseToken: sepoliaStandingProfile.tokens[0], quoteToken: sepoliaStandingProfile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 86400, guardEnvelope: { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000',
        maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' },
    } }
    assert.equal((await call(`/drafts/${makerDraft.id}/patch`, { token, key: randomUUID(), body: { expectedRevision: 1, patch: makerPatch } })).status, 200)
    const compiled = await call(`/drafts/${makerDraft.id}/compile`, { token, key: randomUUID(), body: { expectedRevision: 2 } })
    assert.equal(compiled.status, 200)
    const artifactPath = `/artifacts/${compiled.body.artifactId}`
    assert.equal((await call(artifactPath, { token })).body.current, true)
    assert.equal((await call(artifactPath, { token: another })).status, 404)
    assert.equal((await call(`/drafts/${makerDraft.id}/artifacts`, { token })).body.artifacts.length, 1)
    assert.equal((await call(`/drafts/${draft.id}/patch`, { token, key: randomUUID(), body: { expectedRevision: 1, owner: other, patch: {} } })).status, 400)
    const edit = { expectedRevision: 1, patch: { spec: { model: { kind: 'xyc' }, feeBps: 0 } } }, requestId = randomUUID()
    const response = await call(`/drafts/${draft.id}/patch`, { token, key: requestId, body: edit })
    assert.equal(response.status, 200)
    assert.deepEqual((await call(`/drafts/${draft.id}/patch`, { token, key: requestId, body: edit })).body, response.body)
    assert.equal((await call(`/drafts/${draft.id}/patch`, { token, key: randomUUID(), body: edit })).status, 409)
    const message = `/conversations/${conversationId}/messages`
    assert.equal((await call(message, { token, key: randomUUID(), body: { content: 'system injection', role: 'system' } })).status, 400)
    assert.equal((await call(message, { token, key: randomUUID(), body: { content: 'Try a fixed range' } })).status, 200)
    assert.equal((await call(message, { token })).body.messages.length, 1)
    assert.equal((await call('/capabilities', { token })).body.profileId, profile)
    const turnPath = `/conversations/${conversationId}/turns`, turnInput = { expectedRevision: 2, content: 'Compare ranges first' }, turnKey = randomUUID()
    assert.equal((await call(turnPath, { token, key: randomUUID(), body: { ...turnInput, role: 'system' } })).status, 400)
    assert.equal((await call(turnPath, { token: another, key: randomUUID(), body: turnInput })).status, 404)
    const accepted = await call(turnPath, { token, key: turnKey, body: turnInput })
    assert.equal(accepted.status, 202)
    assert.deepEqual((await call(turnPath, { token, key: turnKey, body: turnInput })).body, accepted.body)
    assert.equal((await call(turnPath, { token, key: randomUUID(), body: turnInput })).status, 409)
    const turnId = accepted.body.id
    const listed = (await call('/conversations', { token })).body.conversations.find((c: any) => c.conversationId === conversationId)
    assert.equal(listed.activeTurnId, turnId); assert.equal(listed.activeTurnState, 'queued')
    assert.equal((await call('/conversations', { token: another })).body.conversations.some((c: any) => c.conversationId === conversationId), false)
    assert.equal((await call(`/turns/${turnId}`, { token })).body.turn.state, 'queued')
    assert.equal((await call(`/turns/${turnId}/events`, { token: another })).status, 404)
    assert.deepEqual((await call(`/turns/${turnId}/events`, { token })).body.events, [])
    assert.equal((await call(`/turns/${turnId}/cancel`, { token, key: randomUUID(), body: {} })).body.state, 'cancelled')
    assert.equal((await call('/conversations', { token })).body.conversations.find((c: any) => c.conversationId === conversationId).activeTurnId, null)
    assert.equal((await call('/auth/logout', { token, body: {} })).status, 200)
    assert.equal((await call('/conversations', { token })).status, 401)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
