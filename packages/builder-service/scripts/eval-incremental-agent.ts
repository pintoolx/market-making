import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { sepoliaStandingProfile, validateStrategy } from '@pintool/strategy-builder'
import { createDesignAgent, openAIModel } from '../src/design-agent.ts'
import { database, migrate, createStore } from '../src/index.ts'

// Consumes credentials opaquely. Only public fixture conversations and test database state are used.
// This does not exercise the UI, private policy editor, publication or chain settlement.
const fixtureOwner = 'wallet:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
const modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
const turnLimit = Number(process.argv[2] ?? '7')
let admin: ReturnType<typeof database> | undefined, pool: ReturnType<typeof database> | undefined
try {
  assert.ok(Number.isInteger(turnLimit) && turnLimit >= 1 && turnLimit <= 7)
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Local test database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const store = createStore(pool, sepoliaStandingProfile.id)
  const created = await store.create(fixtureOwner, randomUUID(), { title: 'Incremental public limits and curve changes', kind: 'template' })
  const model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400
  const prompts = [
    'I want a zero-fee WETH/USDC constant-product template on Ethereum Sepolia. Save only a WETH per-swap limit of 0.05 for now. Leave the USDC limit, both inventory limits and deadline undecided. Do not fill them in or allocate Maker assets.',
    'Add only a USDC per-swap limit of 125. Keep WETH at 0.05 and leave other undecided fields empty.',
    `Now add post-swap inventory limits of 2 WETH / 5000 USDC and Unix deadline ${deadline}. Save and validate, preserving everything else.`,
    'Change to Pegged with reference price 2500 USDC/WETH and amplification 1. Preserve per-swap limits, inventory limits, deadline and zero fees. Update the old curve requirement.',
    'Switch to fixed-range CLMM at 2200 to 2800 USDC/WETH. Replace the Pegged requirement and preserve all confirmed limits.',
    'Tighten only the WETH per-swap limit from 0.05 to 0.04. Preserve all other settings and limits.',
    'Do not edit yet. Are a WETH per-swap maximum of 0.04 and a request to raise it to 0.1 contradictory? Identify the conflict for my review without choosing for me.',
  ].slice(0, turnLimit)
  const evidence: unknown[] = []
  const path = new URL('../../../.cache/builder/', import.meta.url)
  await mkdir(path, { recursive: true })
  for (const [index, content] of prompts.entries()) {
    const message = await store.appendUserMessage(fixtureOwner, randomUUID(), { conversationId: created.conversationId, content })
    const agent = createDesignAgent(model, { profile: sepoliaStandingProfile, turnId: randomUUID(), sourceMessageId: message.id,
      nowSec: Math.floor(Date.now() / 1000), repository: {
        read: () => store.get(fixtureOwner, created.draft.id),
        patch: (requestId, expectedRevision, patch) => store.patch(fixtureOwner, requestId, { draftId: created.draft.id, expectedRevision, patch }),
        restore: (requestId, expectedRevision, revision) => store.restore(fixtureOwner, requestId, { draftId: created.draft.id, expectedRevision, revision }),
        history: () => store.history(fixtureOwner, created.draft.id),
      } })
    const history = await store.messages(fixtureOwner, created.conversationId)
    console.log(JSON.stringify({ turn: index + 1, state: 'running' }))
    const result = await agent.stream({ messages: history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string })),
      abortSignal: AbortSignal.timeout(120000) })
    let reply = ''
    const streamErrors: unknown[] = []
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') reply += chunk.text
      if (chunk.type === 'error') {
        const error = chunk.error
        streamErrors.push({ type: error instanceof Error ? error.name : typeof error,
          status: error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined })
      }
    }
    const steps = await result.steps, toolNames = steps.flatMap(s => s.toolCalls.map(t => t.toolName))
    const draft = await store.get(fixtureOwner, created.draft.id)
    evidence.push({ turn: index + 1, prompt: content, reply, toolNames, draft, usage: await result.totalUsage, streamErrors,
      stepFinishes: steps.map(s => s.finishReason),
      tools: steps.flatMap(s => s.toolResults.map(t => ({ name: t.toolName, input: t.input, output: t.output }))) })
    await writeFile(new URL('live-incremental-eval.json', path), JSON.stringify({ modelId, recordedAt: new Date().toISOString(), evidence }, null, 2) + '\n')
    assert.ok(reply.trim(), 'agent must return visible text')
    assert.equal(streamErrors.length, 0, 'agent stream must finish without errors')
    await pool.query(`INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES ($1,$2,$3,'assistant',$4)`,
      [randomUUID(), created.conversationId, fixtureOwner, reply])
    const caps = { maxAmountBasePerSwap: index >= 5 ? '40000000000000000' : '50000000000000000',
      ...(index >= 1 ? { maxAmountQuotePerSwap: '125000000' } : {}),
      ...(index >= 2 ? { maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' } : {}),
    }
    assert.deepEqual(draft.spec.guardEnvelope, caps)
    assert.equal(draft.spec.baseToken?.address, sepoliaStandingProfile.tokens[0]!.address)
    assert.equal(draft.spec.quoteToken?.address, sepoliaStandingProfile.tokens[1]!.address)
    assert.equal(draft.spec.feeBps, 0); assert.equal(draft.allocations, undefined); assert.equal(draft.maker, undefined)
    assert.equal(draft.spec.deadline, index >= 2 ? deadline : undefined)
    assert.deepEqual(draft.spec.model, index < 3 ? { kind: 'xyc' } : index === 3 ? { kind: 'pegged', referencePrice: '2500', amplification: '1' }
      : { kind: 'concentrated', minPrice: '2200', maxPrice: '2800' })
    assert.equal(validateStrategy(draft, sepoliaStandingProfile, Math.floor(Date.now() / 1000)).ready, index >= 2)
    if (index === 6) assert.deepEqual(draft, (evidence[5] as { draft: unknown }).draft, 'conflict discussion must leave the draft unchanged')
    console.log(JSON.stringify({ turn: index + 1, state: 'passed', revision: draft.revision, toolNames, reply: reply.slice(0,600) }))
  }
  console.log(JSON.stringify({ result: 'passed', turns: prompts.length, modelId }))
} catch (error) {
  // Never print SDK request/response objects, headers or environment. Assertion context is public test data only.
  console.error(JSON.stringify({ result: 'failed', errorType: error instanceof Error ? error.name : 'unknown',
    status: error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0,300) : undefined }))
  process.exitCode = 1
} finally {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
}
