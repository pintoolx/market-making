import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseExecutionRequest, requestDigest } from '../src/execution-request.ts'

const strategy = {
  schema: 'aqua-swapvm-v1.0.2', chainId: 84532, maker: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tokens: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0xcccccccccccccccccccccccccccccccccccccccc'], amounts: ['2000000000000000000', '5000000000'],
  program: { kind: 'xyc', feeBps: 30, deadline: 1800000000, salt: '42' }, meta: { producer: 'tee', strategyVersion: 1, paramsRevision: 1 },
}
const input = () => ({ schema: 'aqua-execution-v1', requestId: 'ship-1', sessionId: 'maker-session', action: 'ship', strategy: structuredClone(strategy), policy: { tokens: [...strategy.tokens], baselineAmounts: [...strategy.amounts], maxDrawdownBps: 100, maxPriceAgeSec: 86520 } })

test('execution JSON canonicalizes addresses and object order for idempotency', () => {
  const a = input(), b = input()
  b.strategy.maker = '0x' + b.strategy.maker.slice(2).toUpperCase()
  const reversed = Object.fromEntries(Object.entries(b).reverse())
  assert.deepEqual(parseExecutionRequest(a), parseExecutionRequest(reversed))
  assert.equal(requestDigest(parseExecutionRequest(a)), requestDigest(parseExecutionRequest(reversed)))
  b.strategy.program.feeBps = 50
  assert.notEqual(requestDigest(parseExecutionRequest(a)), requestDigest(parseExecutionRequest(b)))
})

test('execution input rejects unknown fields, lossy amounts, invalid bounds and a reset benchmark', () => {
  const cases: ((v: ReturnType<typeof input>) => void)[] = [
    v => { v.requestId = '../escape' },
    v => { v.strategy.chainId = 1.5 },
    v => { v.strategy.maker = '0x1234' },
    v => { v.strategy.tokens[0] = '0x' + '0'.repeat(40) },
    v => { v.strategy.tokens[0] = v.strategy.tokens[1]! },
    v => { v.strategy.amounts[0] = '2e18' },
    v => { v.strategy.amounts[0] = '02000000000000000000' },
    v => { v.strategy.amounts[0] = '0' },
    v => { v.strategy.amounts[0] = (2n ** 256n).toString() },
    v => { v.strategy.program.salt = (2n ** 64n).toString() },
    v => { v.strategy.program.deadline = 2 ** 40 },
    v => { v.strategy.program.feeBps = 10000 },
    v => { v.strategy.meta.paramsRevision = -1 },
    v => { v.policy.baselineAmounts[1] = '100' },
    v => { v.policy.tokens.reverse() },
    v => { Object.assign(v, { calldata: '0x1234' }) },
    v => { Object.assign(v.strategy.program, { receiver: strategy.maker }) },
  ]
  for (const change of cases) { const v = input(); change(v); assert.throws(() => parseExecutionRequest(v)) }
  assert.throws(() => parseExecutionRequest(null))
})

test('non-ship commands require an expected strategy and cannot replace the stored policy', () => {
  const base = { schema: 'aqua-execution-v1', requestId: 'swap-1', sessionId: 'session', expectedStrategyHash: '0x' + '1'.repeat(64) }
  const swap = { ...base, action: 'swap', tokenIn: strategy.tokens[1], amountIn: '100000000', slippageBps: 50 }
  assert.equal(parseExecutionRequest(swap).action, 'swap')
  assert.throws(() => parseExecutionRequest({ ...swap, amountIn: 100000000 }))
  assert.throws(() => parseExecutionRequest({ ...swap, expectedStrategyHash: undefined }))
  assert.throws(() => parseExecutionRequest({ ...swap, slippageBps: 10000 }))
  assert.throws(() => parseExecutionRequest({ ...base, action: 'rebalance', strategy, policy: input().policy }))
  assert.throws(() => parseExecutionRequest({ ...base, action: 'dock', revokeAllowances: 'true' }))
})
