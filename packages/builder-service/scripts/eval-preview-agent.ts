import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderSimulationFixture } from '../../../contracts/aqua-executor/scripts/builder-simulation-fixture.ts'
import { database, migrate, builderHandler, createTurns, runDesignTurn, openAIModel } from '../src/index.ts'

// Real OpenAI with public Provider intent, signed local HTTP, and disposable PostgreSQL.
const account = privateKeyToAccount(generatePrivateKey()), name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
const origin = 'https://pintool-eval.example', modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
let pool: ReturnType<typeof database> | undefined, admin: ReturnType<typeof database> | undefined, server: ReturnType<typeof createServer> | undefined
const evidence: unknown[] = [], directory = new URL('../../../.cache/builder/', import.meta.url)
try {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'local disposable database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id, designEnabled: true })
  server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/builder`
  let token: string | undefined
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: 'Bearer ' + token } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `HTTP ${response.status}`)
    return await response.json() as any
  }
  const challenge = await call('/auth/challenge', { address: account.address })
  token = (await call('/auth/login', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) })).token
  const created = await call('/conversations', { title: 'Provider curve and execution-limit comparison', kind: 'template' })
  const fixture = builderSimulationFixture('xyc', account.address.toLowerCase()), { profileId: _profileId, ...spec } = fixture.spec
  await call(`/drafts/${created.draft.id}/patch`, { expectedRevision: 1, patch: { spec } })
  const turns = createTurns(pool), model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const prompts = [
    'This is a Provider template, not a Maker. Preserve all settings and use explicit hypothetical allocations of 0.01 WETH / 25 USDC. Preview separate taker inputs of 0.0001 WETH and 0.001 WETH. Explain Maker payment directions and differences; do not request a real wallet or claim production readiness.',
    'Change only the USDC per-swap limit to 0.1 USDC. Save and repeat the two independent previews with the same hypothetical allocations. Can this block a swap even when the taker input is WETH?',
    'Restore the USDC per-swap limit to 12.5 and switch to fixed-range CLMM at 2200 to 2800 USDC/WETH. Preserve other caps, zero fees and deadline. Repeat the same allocations and two independent scenarios, comparing XYC. Do not claim automatic range tracking.',
    'Switch to Pegged with reference price 2500 USDC/WETH and amplification 1; preserve other limits and deadline. Use hypothetical allocations of 0.007 WETH / 30 USDC and preview a taker input of 0.0001 WETH. Explain whether the reference guarantees execution at 2500 and distinguish preview from settlement.',
    'Read saved previews and compare the current revision with the earlier USDC-cap rejection. Do not modify settings or generate new previews or simulations.',
  ]
  await mkdir(directory, { recursive: true })
  for (const [index, content] of prompts.entries()) {
    const before = (await call(`/drafts/${created.draft.id}`)).draft
    const accepted = await call(`/conversations/${created.conversationId}/turns`, { content, expectedRevision: before.revision })
    console.log(JSON.stringify({ turn: index + 1, state: 'model-running' }))
    const claimed = (await turns.claim())!; assert.equal(claimed.turnId, accepted.id)
    await runDesignTurn(pool, profile, model, claimed)
    const turn = (await call(`/turns/${accepted.id}`)).turn
    assert.equal(turn.state, 'succeeded')
    const events = (await call(`/turns/${accepted.id}/events`)).events
    const reply = (await call(`/conversations/${created.conversationId}/messages`)).messages.find((m: any) => m.id === turn.messageId)?.content
    assert.ok(reply)
    const draft = (await call(`/drafts/${created.draft.id}`)).draft
    const rows = (await call(`/drafts/${draft.id}/previews`)).previews
    const previews = await Promise.all(rows.map((r: any) => call(`/previews/${r.previewId}`)))
    evidence.push({ turn: index + 1, content, reply, draft, toolEvents: events.filter((e: any) => e.kind === 'tool').map((e: any) => e.payload), previews })
    await writeFile(new URL('preview-agent-evaluation.json', directory), JSON.stringify({ modelId, recordedAt: new Date().toISOString(),
      mode: 'real-openai-local-authenticated-http-and-postgres', publicChainWrites: 0, evidence }, null, 2) + '\n')
    assert.equal(draft.kind, 'template'); assert.equal(draft.maker, undefined); assert.equal(draft.allocations, undefined)
    assert.deepEqual(draft.spec.guardEnvelope, { ...fixture.spec.guardEnvelope, maxAmountQuotePerSwap: index === 1 ? '100000' : '12500000' })
    assert.equal(draft.spec.feeBps, 0); assert.equal(draft.spec.deadline, fixture.spec.deadline)
    assert.deepEqual(draft.spec.model, index < 2 ? { kind: 'xyc' } : index === 2 ? { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' }
      : { kind: 'pegged', referencePrice: '2500', amplification: '1' })
    const current = previews.find((p: any) => p.current)
    assert.ok(current); assert.equal(current.payload.allocationSource, 'hypothetical'); assert.equal(current.payload.registrationReady, false)
    assert.deepEqual(current.payload.allocations, index < 3 ? fixture.allocations : { baseAtomic: '7000000000000000', quoteAtomic: '30000000' })
    const trades = current.payload.scenarios.flatMap((s: any) => s.trades)
    assert.deepEqual(trades.map((t: any) => t.amountInAtomic).sort(), index < 3 ? ['100000000000000','1000000000000000'] : ['100000000000000'])
    assert.ok(trades.every((t: any) => t.tokenIn === 'base'))
    assert.ok(current.payload.scenarios.every((s: any) => s.trades.length === 1), 'independent scenarios must reset their allocation')
    assert.ok(trades.every((t: any) => index === 1 ? !t.admittedUnderAssumptions && t.reasons.includes('guard-amount-cap') : t.admittedUnderAssumptions))
    if (index === 0 || index === 4) assert.deepEqual(draft, before)
    if (index < 4) assert.ok(events.some((e: any) => e.kind === 'tool' && e.payload.name === 'previewScenarios' && e.payload.ok))
    else assert.equal(events.filter((e: any) => e.kind === 'tool' && ['previewScenarios','simulateLifecycle','createOrPatchDraft'].includes(e.payload.name)).length, 0)
    console.log(JSON.stringify({ turn: index + 1, state: 'passed', revision: draft.revision, reply }))
  }
  console.log(JSON.stringify({ result: 'passed', turns: prompts.length, modelId, publicChainWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', type: error instanceof Error ? error.name : 'unknown',
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : undefined }))
  process.exitCode = 1
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
}
