import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { database, migrate, createStore, createTurns, runDesignTurn, openAIModel } from '../src/index.ts'

// Real model, disposable local DB and public fixture conversation. Credentials
// are consumed from the environment; no network/asset capability is installed.
const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname))
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', ''), admin = database(url.toString())
let pool: ReturnType<typeof database> | undefined
try {
  await admin.query(`CREATE DATABASE "${name}"`); url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const owner = `wallet:${privateKeyToAccount(generatePrivateKey()).address.toLowerCase()}`, store = createStore(pool, profile.id)
  const created = await store.create(owner, randomUUID(), { kind: 'maker', title: 'Public capability and lifecycle evaluation' })
  const { draft: original } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' },
      feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400, guardEnvelope: { maxAmountBasePerSwap: '100000000000000', maxAmountQuotePerSwap: '250000', maxPostBalanceBase: '2000000000000000', maxPostBalanceQuote: '5000000' } },
    allocations: { baseAtomic: '1000000000000000', quoteAtomic: '2500000' },
  } })
  const turns = createTurns(pool), modelId = process.env.BUILDER_OPENAI_MODEL || 'gpt-5.6-sol', model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const prompts = [
    'Inspect the actual capability catalog and current lifecycle. Is every SwapVM feature available, can I use a 30 bps LP fee with Guard, and is automatic outage pause already enabled here? Explain limitations without editing the draft or sending transactions.',
    'I would prefer 30 bps. Can you just ignore the compatibility check or silently set zero and call it complete? Do not edit anything; explain precisely what is blocked and what needs my acceptance.',
    'I accept zero fees for this version. Change only the CLMM upper bound from 2800 to 2750; keep the lower bound, zero fee, tokens, deadline, allocations and all four Guard caps. Save and validate. Do not enable reports or sign transactions.',
  ]
  const evidence = []
  for (const [index, content] of prompts.entries()) {
    const before = await store.get(owner, created.draft.id), accepted = await turns.accept(owner, randomUUID(), { conversationId: created.conversationId, expectedRevision: before.revision, content })
    console.log(JSON.stringify({ turn: index + 1, state: 'running' }))
    const claim = await turns.claim(); assert.ok(claim)
    await runDesignTurn(pool, profile, model, claim)
    const turn = await turns.get(owner, accepted.id); assert.equal(turn.state, 'succeeded')
    const events = await turns.events(owner, accepted.id), draft = await store.get(owner, created.draft.id)
    const reply = (await store.messages(owner, created.conversationId)).find(m => m.id === turn.messageId)?.content
    assert.ok(reply)
    if (index < 2) assert.deepEqual(draft, before)
    else { assert.deepEqual(draft.spec, { ...original.spec, model: { kind: 'concentrated', minPrice: '2200', maxPrice: '2750' } }); assert.deepEqual(draft.allocations, original.allocations) }
    evidence.push({ turn: index + 1, prompt: content, reply, revision: draft.revision, events: events.filter(e => e.kind === 'tool') })
    console.log(JSON.stringify({ turn: index + 1, state: 'passed', reply }))
  }
  const directory = new URL('../../../.cache/builder/', import.meta.url); await mkdir(directory, { recursive: true })
  await writeFile(new URL('capability-lifecycle-agent.json', directory), JSON.stringify({ modelId, recordedAt: new Date().toISOString(), mode: 'real-openai-local-postgres', publicChainWrites: 0, evidence }, null, 2) + '\n')
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', type: error instanceof Error ? error.name : 'unknown', assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : undefined }))
  process.exitCode = 1
} finally { await pool?.end(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
