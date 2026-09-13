import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { database, migrate, createStore, createArtifacts, createAutomation, createEventDelivery, runEventWorker, revokeMessage, builderHandler, createAuthorizationBindings, bindingMessage, createOutboxDispatcher, createSignedEventIngress, normalizeEvmLog, normalizeMarketUpdate } from '../src/index.ts'
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>
before(async () => {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => { await pool?.end(); if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } } })

async function fixture() {
  const account = privateKeyToAccount(generatePrivateKey()), owner = 'wallet:' + account.address.toLowerCase(), store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { title: 'Event strategy', kind: 'maker' })
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } },
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' },
  } })
  const artifact = await createArtifacts(pool, profile).compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2 })
  const automation = createAutomation(pool, profile), prepared = await automation.prepare(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, artifactId: artifact.artifactId })
  const confirmed = await automation.confirm(owner, randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature: await account.signMessage({ message: prepared.intent.message }) })
  const compiled = await createArtifacts(pool, profile).get(owner, artifact.artifactId), bindings = createAuthorizationBindings(pool, profile, {
    verifyReport: async input => ({ chainId: profile.chainId, maker: input.owner.slice(7) as `0x${string}`, guard: profile.guard, router: profile.router, strategyHash: input.artifact.payload.strategyHash,
      reportSchema: 2 as const, reportDigest: input.reportDigest, reportTransactionHash: input.reportTransactionHash, reportNonce: input.reportNonce, accepted: true as const }),
  }), reportDigest = digestJson({ report: 'fixture', strategyHash: compiled.payload.strategyHash }), reportTransactionHash = ('0x' + '4'.repeat(64)) as `0x${string}`
  const bindingIntent = await bindings.prepare(owner, randomUUID(), { draftId: draft.id, expectedRevision: 2, artifactId: artifact.artifactId, reportDigest, reportTransactionHash, reportNonce: '1' })
  const binding = await bindings.confirm(owner, randomUUID(), { intentId: bindingIntent.intent.id, digest: bindingIntent.digest, signature: await account.signMessage({ message: bindingIntent.intent.message }) })
  return { account, owner, draft, artifact, consent: confirmed.consent, binding: binding.binding }
}

test('event inbox is durable, deduplicated and change-only across evaluation and delivery', async () => {
  const f = await fixture(), reports = [digestJson({ allowedDirections: 1, cap: 'a' }), digestJson({ allowedDirections: 1, cap: 'b' })] as [`0x${string}`, `0x${string}`], evaluations: string[] = []
  const events = createEventDelivery(pool, profile, {
    evaluate: async input => { evaluations.push(input.event.eventId); return { status: 'changed', reportHash: reports[evaluations.length > 2 ? 1 : 0], report: { allowedDirections: evaluations.length > 2 ? 1 : 3, cap: evaluations.length } } },
    deliver: async input => ({ transactionHash: ('0x' + '1'.repeat(64)) as `0x${string}`, receipt: { reportHash: input.reportHash, nonce: input.nonce } }),
  })
  const enabled = await events.enable(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: 2, artifactId: f.artifact.artifactId, consentId: f.consent.id })
  assert.equal(enabled.subscription.state, 'enabled')
  const event = { source: 'market.kraken', eventId: 'trade-1', kind: 'market.updated', payload: { price: '2500' }, observedAt: new Date().toISOString() }
  const first = await events.ingest(event), duplicate = await events.ingest(event)
  assert.equal(first.duplicate, false); assert.equal(first.jobs.length, 1); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.jobs.length, 0)
  const job = await events.claimEvaluation(); assert.ok(job)
  const evaluated = await events.evaluate(job!.id, job!.token); assert.equal(evaluated.result.status, 'changed'); assert.ok(evaluated.deliveryId)
  assert.equal((await events.deliver(evaluated.deliveryId!)).status, 'accepted')
  const event2 = { ...event, eventId: 'trade-2', payload: { price: '2500' } }
  await events.ingest(event2); const job2 = await events.claimEvaluation(); assert.ok(job2); const unchanged = await events.evaluate(job2!.id, job2!.token)
  assert.equal(unchanged.result.status, 'unchanged'); assert.equal(unchanged.deliveryId, undefined)
  const event3 = { ...event, eventId: 'trade-3', payload: { price: '2600' } }
  await events.ingest(event3); const job3 = await events.claimEvaluation(); assert.ok(job3); const changed = await events.evaluate(job3!.id, job3!.token)
  assert.equal(changed.result.status, 'changed'); assert.ok(changed.deliveryId)
  assert.equal((await events.deliver(changed.deliveryId!)).status, 'accepted')
  const current = await events.current(f.owner, f.draft.id, 2); assert.equal(current.subscription?.lastReportHash, reports[1]); assert.equal(current.subscription?.lastReportNonce, '2')
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM builder.report_deliveries WHERE subscription_id=$1 AND status='accepted'", [enabled.subscription.id])).rows[0].count, 2)
  assert.deepEqual(evaluations, ['trade-1', 'trade-2', 'trade-3'])
  await events.stop(f.owner, randomUUID(), { subscriptionId: enabled.subscription.id })
})

test('stopping, reorg and consent revocation prevent late event work from re-enabling a Maker', async () => {
  const f = await fixture(), events = createEventDelivery(pool, profile, { evaluate: async () => ({ status: 'changed', reportHash: digestJson({ paused: true }), report: { paused: true } }) })
  const enabled = await events.enable(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: 2, artifactId: f.artifact.artifactId, consentId: f.consent.id })
  await events.ingest({ source: 'chain.sepolia.test2', eventId: 'log-1', kind: 'guard.changed', payload: {}, observedAt: new Date().toISOString() })
  await events.stop(f.owner, randomUUID(), { subscriptionId: enabled.subscription.id })
  assert.equal((await events.current(f.owner, f.draft.id, 2)).subscription?.state, 'stopped')
  const event2 = await events.ingest({ source: 'chain.sepolia.test2', eventId: 'log-2', kind: 'guard.changed', payload: {}, observedAt: new Date().toISOString() })
  assert.equal(event2.jobs.length, 0)
  assert.equal((await events.markReorg('chain.sepolia.test2', 'log-1')).changed, true)
  assert.equal((await events.markReorg('chain.sepolia.test2', 'log-1')).changed, false)
  const automation = createAutomation(pool, profile)
  const revoked = await automation.revoke(f.owner, randomUUID(), { consentId: f.consent.id, signature: await f.account.signMessage({ message: revokeMessage(f.consent) }) })
  assert.equal(revoked.consent.active, false)
  assert.equal((await events.current(f.owner, f.draft.id, 2)).subscription?.state, 'stopped')
})

test('the resident worker recovers queued events after the browser is gone', async () => {
  const f = await fixture(), outbox: string[] = [], events = createEventDelivery(pool, profile, { evaluate: async () => ({ status: 'changed', reportHash: digestJson({ worker: true }), report: { worker: true } }), deliver: async () => ({ transactionHash: ('0x' + '2'.repeat(64)) as `0x${string}` }) })
  const enabled = await events.enable(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: 2, artifactId: f.artifact.artifactId, consentId: f.consent.id })
  await events.ingest({ source: 'market.worker', eventId: 'worker-1', kind: 'market.updated', payload: { price: '2500' }, observedAt: new Date().toISOString() })
  const controller = new AbortController(), running = runEventWorker(pool, profile, { evaluate: async () => ({ status: 'changed', reportHash: digestJson({ worker: true }), report: { worker: true } }), deliver: async () => ({ transactionHash: ('0x' + '2'.repeat(64)) as `0x${string}` }) }, { pollMs: 50, signal: controller.signal, outbox: async entry => { outbox.push(entry.kind) } })
  await new Promise(resolve => setTimeout(resolve, 250)); controller.abort(); await running
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM builder.report_deliveries WHERE subscription_id=$1 AND status='accepted'", [enabled.subscription.id])).rows[0].count, 1)
  assert.ok(outbox.includes('report-delivery.pending'))
})

test('event adapters authenticate ingress and retain reorg-safe source identity', async () => {
  const ingress = createSignedEventIngress('adapter-secret', { clock: () => 1000 }), body = { z: 1, eventId: 'market-1', price: '2500', observedAt: new Date(1000000).toISOString() }, market = { eventId: 'market-1', price: '2500', observedAt: body.observedAt }
  const signature = ingress.sign(body, 1000)
  assert.deepEqual(ingress.verify({ headers: { 'x-pintool-event-timestamp': '1000', 'x-pintool-event-signature': signature }, body }), body)
  assert.throws(() => ingress.verify({ headers: { 'x-pintool-event-timestamp': '1000', 'x-pintool-event-signature': ingress.sign({ ...body, z: 2 }, 1000) }, body }), /invalid/)
  assert.deepEqual(normalizeMarketUpdate('market.kraken', market).payload, { price: '2500' })
  const log = normalizeEvmLog('chain.sepolia.guard', { chainId: profile.chainId, blockNumber: '42', blockHash: ('0x' + 'a'.repeat(64)), transactionHash: ('0x' + 'b'.repeat(64)), logIndex: 3,
    address: profile.guard, topics: [('0x' + 'c'.repeat(64))], data: '0x', observedAt: new Date(1000000).toISOString() })
  assert.equal(log.eventId, '0x' + 'b'.repeat(64) + ':3'); assert.equal(log.blockNumber, '42'); assert.equal(log.logIndex, 3)
  assert.throws(() => normalizeEvmLog('chain.sepolia.guard', { chainId: profile.chainId, blockNumber: '42', transactionHash: ('0x' + 'b'.repeat(64)), logIndex: 3,
    address: profile.guard, topics: [], data: '0x', observedAt: new Date(1000000).toISOString() }), /expected.*string/)
})

test('signed event ingress route accepts only gateway-authenticated public events', async () => {
  const f = await fixture(), origin = 'http://localhost:3401', ingress = createSignedEventIngress('http-secret', { clock: () => 1000 }), handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id }, { eventIngress: ingress })
  const server = createServer((request, response) => { void handler(request, response).then(ok => { if (!ok) { response.statusCode = 404; response.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`, body = { source: 'market.gateway', eventId: 'gateway-1', kind: 'market.updated', payload: { price: '2500' }, observedAt: new Date(1000000).toISOString() }
  try {
    const common = { origin, 'content-type': 'application/json', 'x-pintool-event-timestamp': '1000', 'x-pintool-event-signature': ingress.sign(body, 1000) }
    const accepted = await fetch(base + '/events/ingest', { method: 'POST', headers: common, body: JSON.stringify(body) }); assert.equal(accepted.status, 202); assert.equal((await accepted.json() as { duplicate: boolean }).duplicate, false)
    const duplicate = await fetch(base + '/events/ingest', { method: 'POST', headers: common, body: JSON.stringify(body) }); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true)
    const rejected = await fetch(base + '/events/ingest', { method: 'POST', headers: { ...common, 'x-pintool-event-signature': ingress.sign({ ...body, eventId: 'forged' }, 1000) }, body: JSON.stringify(body) }); assert.equal(rejected.status, 401)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  assert.equal(f.owner.startsWith('wallet:'), true)
})

test('outbox dispatcher leases, retries and acknowledges rows without losing them', async () => {
  const resource = randomUUID(), retryResource = randomUUID()
  await pool.query("UPDATE builder.outbox SET dispatched_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE dispatched_at IS NULL")
  await pool.query("INSERT INTO builder.outbox(owner,kind,resource_id,revision) VALUES('system','adapter.test',$1,1),('system','adapter.retry',$2,1)", [resource, retryResource])
  let first = true; const seen: string[] = [], dispatcher = createOutboxDispatcher(pool, async entry => { seen.push(entry.kind); if (entry.kind === 'adapter.retry' && first) { first = false; throw new Error('temporary') } }, { leaseMs: 100 })
  assert.equal(await dispatcher.process(1), 1)
  assert.equal((await pool.query('SELECT dispatched_at IS NOT NULL AS dispatched, attempts FROM builder.outbox WHERE resource_id=$1', [resource])).rows[0].dispatched, true)
  assert.equal(await dispatcher.process(5), 0)
  await pool.query("UPDATE builder.outbox SET available_at=clock_timestamp() WHERE resource_id=$1", [retryResource])
  assert.equal(await dispatcher.process(5), 1)
  assert.deepEqual(seen.sort(), ['adapter.retry', 'adapter.retry', 'adapter.test'])
})

test('event subscription HTTP routes bind the authenticated Maker and reject resource injection', async () => {
  const f = await fixture(), origin = 'http://localhost:3399', handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id })
  const server = createServer((request, response) => { void handler(request, response).then(ok => { if (!ok) { response.statusCode = 404; response.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`, headers = (token?: string, key?: string) => ({ origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(key ? { 'idempotency-key': key } : {}) })
  const call = (path: string, body: unknown | undefined, token: string) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: headers(token, body === undefined ? undefined : randomUUID()), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    const challenge = await (await fetch(base + '/auth/challenge', { method: 'POST', headers: headers(), body: JSON.stringify({ address: f.account.address }) })).json() as { id: string; message: string }
    const token = (await (await fetch(base + '/auth/login', { method: 'POST', headers: headers(), body: JSON.stringify({ challengeId: challenge.id, signature: await f.account.signMessage({ message: challenge.message }) }) })).json() as { token: string }).token
    assert.equal((await call(`/drafts/${f.draft.id}/event-subscription?revision=2`, undefined, token)).status, 200)
    const enabled = await call(`/drafts/${f.draft.id}/event-subscription`, { expectedRevision: 2, artifactId: f.artifact.artifactId, consentId: f.consent.id }, token)
    assert.equal(enabled.status, 200); const subscription = (await enabled.json() as { subscription: { id: string; state: string } }).subscription; assert.equal(subscription.state, 'enabled')
    assert.equal((await call(`/event-subscriptions/${subscription.id}/stop`, { subscriptionId: 'forged' }, token)).status, 400)
    assert.equal((await call(`/event-subscriptions/${subscription.id}/stop`, {}, token)).status, 200)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('trusted binding requires an independently verified standing report and an exact Maker signature', async () => {
  const f = await fixture(), compiled = await createArtifacts(pool, profile).get(f.owner, f.artifact.artifactId), reportDigest = digestJson({ report: 'standing-v2', strategyHash: compiled.payload.strategyHash }), reportTransactionHash = ('0x' + '3'.repeat(64)) as `0x${string}`, bindings = createAuthorizationBindings(pool, profile, {
    verifyReport: async input => ({ chainId: profile.chainId, maker: input.owner.slice(7) as `0x${string}`, guard: profile.guard, router: profile.router, strategyHash: input.artifact.payload.strategyHash, reportSchema: 2 as const, reportDigest: input.reportDigest, reportTransactionHash: input.reportTransactionHash, reportNonce: input.reportNonce, accepted: true as const }),
  })
  const prepared = await bindings.prepare(f.owner, randomUUID(), { draftId: f.draft.id, expectedRevision: 2, artifactId: f.artifact.artifactId, reportDigest, reportTransactionHash, reportNonce: '1' })
  assert.equal(prepared.intent.registrationReady, false); assert.equal(prepared.digest, digestJson(prepared.intent)); assert.equal(prepared.intent.message, bindingMessage(prepared.intent))
  const confirmed = await bindings.confirm(f.owner, randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature: await f.account.signMessage({ message: prepared.intent.message }) })
  assert.equal(confirmed.binding.strategyHash, compiled.payload.strategyHash); assert.equal((await bindings.current(f.owner, f.draft.id, 2)).binding?.reportTransactionHash, reportTransactionHash)
  await assert.rejects(bindings.confirm('wallet:' + privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature: confirmed.binding.makerSignature }), /not-found/)
})
