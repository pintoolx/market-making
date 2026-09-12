import assert from 'node:assert/strict'
import { test } from 'node:test'
import { syncMandateExecution } from '../src/mandate-sync.ts'
import type { ExecutionResult } from '../src/execution-controller.ts'

const result = (status: 'success' | 'reverted'): ExecutionResult => ({
  schema: 'aqua-execution-result-v1', requestId: 'swap-1', sessionId: 'session-a', action: 'swap',
  status: status === 'success' ? 'completed' : 'failed', outcome: status === 'success' ? 'swapped' : 'reverted on-chain',
  strategyHash: `0x${'1'.repeat(64)}`, plan: { strategy: {} as never, policy: {} as never, finished: false },
  records: '/tmp/record', transactions: [{ step: 'primary', action: 'swap', hash: `0x${'2'.repeat(64)}`, status, blockNumber: '12' }],
})

test('final Aqua receipts are attached to the selected mandate strategy', async () => {
  for (const [status, outcome] of [['success', 'settled'], ['reverted', 'rejected']] as const) {
    let request: { url: string; body: unknown } | undefined
    await syncMandateExecution(result(status), { apiUrl: 'https://api.example/', mandateId: 'mandate-1', providerStrategyId: 'featured-tight-market', fetchImpl: async (input, init) => {
      request = { url: String(input), body: JSON.parse(String(init?.body)) }
      return new Response('{}', { status: 200 })
    } })
    assert.equal(request?.url, 'https://api.example/v1/mandates/mandate-1/executions')
    assert.deepEqual(request?.body, { providerStrategyId: 'featured-tight-market', transactionHash: `0x${'2'.repeat(64)}`, outcome })
  }
})

test('unmined and non-swap results are never presented as mandate evidence', async () => {
  const pending = result('success'); pending.transactions[0]!.status = 'pending'
  await assert.rejects(syncMandateExecution(pending, { apiUrl: 'https://api.example', mandateId: 'mandate-1', providerStrategyId: 'strategy' }), /not final/)
  const ship = { ...result('success'), action: 'ship' as const }
  await assert.rejects(syncMandateExecution(ship, { apiUrl: 'https://api.example', mandateId: 'mandate-1', providerStrategyId: 'strategy' }), /only Aqua swap/)
})
