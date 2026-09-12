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
  const created = await store.create(fixtureOwner, randomUUID(), { title: '逐項公開限制與曲線切換', kind: 'template' })
  const model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId })
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400
  const prompts = [
    '我要在 Ethereum Sepolia 發布 WETH/USDC 一般乘積曲線模板、零费率。先只保存單筆 WETH 上限 0.05；USDC 單筆、兩種庫存上限和期限都還沒決定，這輪不要替我填。也不要設定 Maker 資產。',
    '接著只補 USDC 單筆最多 125，保留 WETH 單筆 0.05。其他未決定的欄位仍不要替我填。',
    `現在補成交後庫存 WETH 最多 2、USDC 最多 5000，策略期限 Unix ${deadline}。請保存並驗證，其他設定全部保留。`,
    '我決定把曲線換成 Pegged，參考價格 2500 USDC/WETH、amplification 1；原本單筆、庫存、期限與零費率全部保留，更新舊的曲線要求。',
    '我改採固定區間 CLMM，價格 2200 到 2800 USDC/WETH。取代前面 Pegged 曲線需求，其他已確認限制完全保留。',
    '只把 WETH 單筆上限從 0.05 收緊到 0.04，其他所有設定與限制保留。',
    '先不要修改：如果我同時要求 WETH 單筆不得超過 0.04，又要求放寬成 0.1，這兩項是否矛盾？請指出衝突讓我確認，不要替我選。',
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
