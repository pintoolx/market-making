import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadDeployment } from '../src/config.ts'
import { parseExecutionRequest } from '../src/execution-request.ts'
import { buildProductStrategies, MAKER_STRATEGY_DEADLINE } from '../src/product-strategies.ts'
import { DEMO_ACCOUNTS, SEPOLIA } from '../src/sepolia.ts'

test('the Sepolia product catalog pins two guarded strategies sharing one Maker balance', () => {
  const items = buildProductStrategies(loadDeployment(SEPOLIA.chainId), DEMO_ACCOUNTS.maker)
  assert.deepEqual(items.map(item => [item.listingId, item.strategyHash]), [
    ['featured-tight-market', '0x3c9b9724581aa371f0c0df6889c7243cb32c692f32af10b1ffd88dbe66deae79'],
    ['featured-defensive-market', '0x4ff3a91ec6ca9204376de326e192eded5a8838a03315c4e85590d89aa7d09b5d'],
  ])
  assert.equal(new Set(items.map(item => item.request.strategy.maker)).size, 1)
  assert.equal(new Set(items.map(item => JSON.stringify(item.request.strategy.amounts))).size, 1)
  assert.equal(new Set(items.map(item => item.request.strategy.guard?.address)).size, 1)
  assert.ok(items.every(item => item.request.strategy.program.deadline === MAKER_STRATEGY_DEADLINE))
  assert.ok(items.every(item => parseExecutionRequest(item.request).action === 'ship'))
  assert.ok(Number(items[0]!.range.min) > Number(items[1]!.range.min))
  assert.ok(Number(items[0]!.range.max) < Number(items[1]!.range.max))
})
