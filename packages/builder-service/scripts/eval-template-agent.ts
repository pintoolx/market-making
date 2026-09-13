import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { defaultTemplatePermissions, publicationMessage, sepoliaStandingProfile as profile, type PolicyEnvelope, type StrategyDraft } from '@pintool/strategy-builder'
import { builderSimulationFixture } from '../../../contracts/aqua-executor/scripts/builder-simulation-fixture.ts'
import { database, migrate, builderHandler, createTurns, runDesignTurn, openAIModel, createTemplates, createStore, krakenTemplatePrice } from '../src/index.ts'

const provider = privateKeyToAccount(generatePrivateKey()), maker = privateKeyToAccount(generatePrivateKey())
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', ''), providerOwner = 'wallet:' + provider.address.toLowerCase()
const origin = 'https://pintool-eval.example', modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
let pool: ReturnType<typeof database> | undefined, admin: ReturnType<typeof database> | undefined, server: ReturnType<typeof createServer> | undefined
const evidence: unknown[] = [], directory = new URL('../../../.cache/builder/', import.meta.url)
try {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'local disposable database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const workflowPublicKey = '11'.repeat(32), store = createStore(pool, profile.id), templates = createTemplates(pool, profile, { origin, workflowPublicKey })
  const fixture = builderSimulationFixture('concentrated', maker.address.toLowerCase()), { profileId: _profileId, ...spec } = fixture.spec
  const created = await store.create(providerOwner, randomUUID(), { title: 'Provider multi-turn permission evaluation', kind: 'template' })
  await store.patch(providerOwner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: { spec } })
  const { intent } = await templates.prepare(providerOwner, randomUUID(), { draftId: created.draft.id, expectedRevision: 2, templateId: null, permissions: defaultTemplatePermissions })
  // Tests publication/permission isolation. No decryption or TEE claim is made for this synthetic envelope.
  const envelope: PolicyEnvelope = { version: 1, ephemeralPublicKey: randomBytes(32).toString('hex'), nonce: randomBytes(24).toString('hex'), ciphertext: randomBytes(48).toString('hex') }
  const published = await templates.publish(providerOwner, randomUUID(), { intentId: intent.id, envelope, signature: await provider.signMessage({ message: publicationMessage(intent, envelope) }) })
  const price = await krakenTemplatePrice(published.template)
  const handler = builderHandler(pool, { origin, chainId: profile.chainId, profileId: profile.id, designEnabled: true }, { templates: { workflowPublicKey } })
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
  const challenge = await call('/auth/challenge', { address: maker.address })
  token = (await call('/auth/login', { challengeId: challenge.id, signature: await maker.signMessage({ message: challenge.message }) })).token
  const instance = await call('/templates/instantiate', { templateId: published.template.templateId, version: 1, digest: published.digest, allocations: fixture.allocations })
  const initial: StrategyDraft = instance.draft, turns = createTurns(pool), model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const prompts = [
    'I am a Maker using a Provider template. Read the draft and permissions, explaining editable and locked parameters. Do not edit or request the private Provider policy.',
    'Narrow the CLMM range to 2300–2700 USDC/WETH, set the public USDC per-swap limit to 10 and change the personal title to My CLMM. Preserve everything else. Save and validate.',
    'I want to raise the upper price to 2900. Check Provider permissions first; if it exceeds the original bound, do not edit. Explain alternatives without creating a new draft.',
    'Restore the initial template instance at revision 1, then change only the Maker USDC allocation to 20, preserving WETH. Save and validate without publishing, registering or trading.',
  ]
  await mkdir(directory, { recursive: true })
  for (const [index, content] of prompts.entries()) {
    const before = (await call(`/drafts/${initial.id}`)).draft
    const accepted = await call(`/conversations/${instance.conversationId}/turns`, { content, expectedRevision: before.revision })
    console.log(JSON.stringify({ turn: index + 1, state: 'model-running' }))
    const claimed = (await turns.claim())!; assert.equal(claimed.turnId, accepted.id)
    await runDesignTurn(pool, profile, model, claimed)
    const turn = (await call(`/turns/${accepted.id}`)).turn
    assert.equal(turn.state, 'succeeded')
    const events = (await call(`/turns/${accepted.id}/events`)).events
    const reply = (await call(`/conversations/${instance.conversationId}/messages`)).messages.find((m: any) => m.id === turn.messageId)?.content
    assert.ok(reply)
    const draft = (await call(`/drafts/${initial.id}`)).draft as StrategyDraft
    evidence.push({ turn: index + 1, content, reply, draft, publicContext: await store.templateContext('wallet:' + maker.address.toLowerCase(), initial.id, draft.revision),
      toolEvents: events.filter((e: any) => e.kind === 'tool').map((e: any) => e.payload) })
    assert.equal(JSON.stringify(evidence).includes(envelope.ciphertext), false)
    await writeFile(new URL('template-agent-evaluation.json', directory), JSON.stringify({ modelId, recordedAt: new Date().toISOString(),
      mode: 'real-openai-local-authenticated-http-postgres', policyMode: 'synthetic-ciphertext-not-TEE-verified',
      publicChainWrites: 0, externalMarketRead: price, providerVersion: published.template, evidence }, null, 2) + '\n')
    assert.deepEqual(draft.templatePin, initial.templatePin)
    if (index === 0 || index === 2) assert.deepEqual(draft, before)
    if (index === 1) {
      assert.deepEqual(draft.spec, { ...initial.spec, title: 'My CLMM', model: { kind: 'concentrated', minPrice: '2300', maxPrice: '2700' },
        guardEnvelope: { ...initial.spec.guardEnvelope, maxAmountQuotePerSwap: '10000000' } })
      assert.deepEqual(draft.allocations, initial.allocations)
    }
    if (index === 3) {
      assert.deepEqual(draft.spec, initial.spec); assert.deepEqual(draft.allocations, { ...initial.allocations, quoteAtomic: '20000000' })
      assert.ok(draft.revision > before.revision)
    }
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
