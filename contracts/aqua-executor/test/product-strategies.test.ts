import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadDeployment } from '../src/config.ts'
import { parseExecutionRequest } from '../src/execution-request.ts'
import { buildProductStrategies, buildProductSwaps, MAKER_STRATEGY_DEADLINE } from '../src/product-strategies.ts'
import { DEMO_ACCOUNTS, SEPOLIA } from '../src/sepolia.ts'

test('the Sepolia product catalog pins two guarded strategies sharing one Maker balance', () => {
  const items = buildProductStrategies(loadDeployment(SEPOLIA.chainId), DEMO_ACCOUNTS.maker)
  assert.deepEqual(items.map(item => [item.listingId, item.strategyHash]), [
    ['featured-tight-market', '0x404b5695e6733ad52c2402a43991c4a3d50181adb1ed94d8c1f404d319899a85'],
    ['featured-defensive-market', '0x7767a30f308311da63a47e530443d8c525267601ee63c8065a3d954a4a900c97'],
  ])
  assert.equal(new Set(items.map(item => item.request.strategy.maker)).size, 1)
  assert.equal(new Set(items.map(item => JSON.stringify(item.request.strategy.amounts))).size, 1)
  assert.equal(new Set(items.map(item => item.request.strategy.guard?.address)).size, 1)
  assert.ok(items.every(item => item.request.strategy.program.deadline === MAKER_STRATEGY_DEADLINE))
  assert.ok(items.every(item => parseExecutionRequest(item.request).action === 'ship'))
  assert.ok(Number(items[0]!.range.min) > Number(items[1]!.range.min))
  assert.ok(Number(items[0]!.range.max) < Number(items[1]!.range.max))
  const swaps = buildProductSwaps(items)
  assert.deepEqual(swaps.map(item => item.expected), ['success', 'success', 'guard-rejection'])
  assert.ok(swaps.every(item => parseExecutionRequest(item.request).action === 'swap'))
})
