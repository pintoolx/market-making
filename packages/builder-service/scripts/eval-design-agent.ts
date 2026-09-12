import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { sepoliaStandingProfile } from '@pintool/strategy-builder'
import { createDesignAgent, openAIModel } from '../src/design-agent.ts'
import { database, migrate, createStore } from '../src/index.ts'

// Consumes credentials opaquely. Only public fixture conversations and test database state are used.
// This does not exercise the UI, private policy editor, publication or chain settlement.
const fixtureOwner = 'wallet:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
const modelId = process.env.BUILDER_OPENAI_MODEL ?? 'gpt-5.6-sol'
const turnLimit = Number(process.argv[2] ?? '5')
let admin: ReturnType<typeof database> | undefined, pool: ReturnType<typeof database> | undefined
try {
  assert.ok(Number.isInteger(turnLimit) && turnLimit >= 1 && turnLimit <= 5)
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Local test database required')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
  const store = createStore(pool, sepoliaStandingProfile.id)
  const created = await store.create(fixtureOwner, randomUUID(), { title: '公開策略多輪驗證', kind: 'template' })
  const model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400
  const prompts = [
    '我想在 Ethereum Sepolia 發布 WETH/USDC 做市策略模板，希望保守一點。先比較固定區間與一般乘積曲線的取捨，暫時不要替 Maker 設定資產。',
    `那選固定區間 2200 到 2800 USDC/WETH，零費率。單筆最多 0.05 WETH 或 125 USDC，成交後庫存各自上限 2 WETH 和 5000 USDC。策略期限用 Unix ${deadline}。幫我保存並驗證這些公開設定。`,
    '沿用其他全部設定，只把上限價格從 2800 改成 2700，下限 2200、零費率及所有交易和庫存限制都保留。',
    '回到剛剛上限價格還是 2800 的那一版，其他設定保持一致。',
    '另外我想每小時自動把資產搬去 Uniswap 然後重置區間，你目前能做嗎？先跟我說限制，不要改掉既有範圍與 caps。',
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
    await writeFile(new URL('live-design-eval.json', path), JSON.stringify({ modelId, recordedAt: new Date().toISOString(), evidence }, null, 2) + '\n')
    assert.ok(reply.trim(), 'agent must return visible text')
    assert.equal(streamErrors.length, 0, 'agent stream must finish without errors')
    await pool.query(`INSERT INTO builder.messages(id,conversation_id,owner,role,content) VALUES ($1,$2,$3,'assistant',$4)`,
      [randomUUID(), created.conversationId, fixtureOwner, reply])
    if (index >= 1) {
      assert.equal(draft.spec.model?.kind, 'concentrated')
      assert.equal(draft.spec.model?.kind === 'concentrated' && draft.spec.model.minPrice, '2200')
      assert.equal(draft.spec.model?.kind === 'concentrated' && draft.spec.model.maxPrice, index === 2 ? '2700' : '2800')
      assert.equal(draft.spec.feeBps, 0)
      assert.deepEqual(draft.spec.guardEnvelope, { maxAmountBasePerSwap: '50000000000000000', maxAmountQuotePerSwap: '125000000',
        maxPostBalanceBase: '2000000000000000000', maxPostBalanceQuote: '5000000000' })
      assert.equal(draft.allocations, undefined)
    }
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
