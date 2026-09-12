import { concentrationBounds } from './concentrated.ts'
import { compileExecution } from './execution-compile.ts'
import type { ExecutionRequest } from './execution-request.ts'
import type { AquaStrategyParams, Deployment, Hex } from './types.ts'

export const MAKER_STRATEGY_RELEASE = 'sepolia-maker-v1'
export const MAKER_STRATEGY_DEADLINE = 1_798_761_600 // 2027-01-01T00:00:00Z

export interface ProductStrategy {
  listingId: string
  name: string
  provider: string
  range: { min: string; max: string }
  request: ExecutionRequest & { action: 'ship' }
  strategyHash: Hex
  strategy: Hex
}

export interface ProductSwap {
  file: string
  expected: 'success' | 'guard-rejection'
  request: ExecutionRequest & { action: 'swap' }
}

type Recipe = {
  listingId: string
  name: string
  range: { min: string; max: string }
  salt: string
  caps: { maxAmount0PerSwap: string; maxAmount1PerSwap: string; maxPostBalance0: string; maxPostBalance1: string }
}

const RECIPES: Recipe[] = [
  {
    listingId: 'featured-tight-market',
    name: 'Tight Market',
    range: { min: '2300', max: '2700' },
    salt: '2026091201',
    caps: { maxAmount0PerSwap: '400000000000000', maxAmount1PerSwap: '1000000', maxPostBalance0: '6000000000000000', maxPostBalance1: '20000000' },
  },
  {
    listingId: 'featured-defensive-market',
    name: 'Defensive Market',
    range: { min: '1800', max: '3200' },
    salt: '2026091202',
    caps: { maxAmount0PerSwap: '200000000000000', maxAmount1PerSwap: '500000', maxPostBalance0: '4400000000000000', maxPostBalance1: '11000000' },
  },
]

/** Public Aqua programs. Private Provider rules and Maker limits only narrow these envelopes through the Guard. */
export function buildProductStrategies(deployment: Deployment, maker: Hex): ProductStrategy[] {
  if (!deployment.guard || deployment.guard.version !== 2) throw new Error('the product strategies require AquaGuard v2')
  const guard = deployment.guard
  const tokens = [deployment.tokens.WETH, deployment.tokens.USDC]
  if (tokens.some(value => !value)) throw new Error('deployment needs WETH and USDC')
  const typedTokens = tokens as [Hex, Hex]
  const amounts = ['4000000000000000', '10000000']

  return RECIPES.map((recipe, index) => {
    const bounds = concentrationBounds(typedTokens, [18, 6], recipe.range.min, recipe.range.max)
    const strategy: AquaStrategyParams = {
      schema: 'aqua-swapvm-v1.0.2',
      chainId: deployment.chainId,
      maker,
      tokens: typedTokens,
      amounts,
      program: { kind: 'concentrated', feeBps: 0, deadline: MAKER_STRATEGY_DEADLINE, salt: recipe.salt, ...bounds },
      guard: { address: guard.address, version: 2, caps: recipe.caps },
      meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: index + 1 },
    }
    const compiled = compileExecution(strategy)
    const request: ProductStrategy['request'] = {
      schema: 'aqua-execution-v1', requestId: `ship-${MAKER_STRATEGY_RELEASE}-${index + 1}`,
      sessionId: `${MAKER_STRATEGY_RELEASE}-${index + 1}`, action: 'ship', strategy,
      policy: { tokens: typedTokens, baselineAmounts: amounts, maxDrawdownBps: 500, maxPriceAgeSec: 86400 },
    }
    return { listingId: recipe.listingId, name: recipe.name, provider: 'PinTool Strategies', range: recipe.range,
      request, strategyHash: compiled.strategyHash, strategy: compiled.strategy }
  })
}

export function buildProductSwaps(strategies: ProductStrategy[]): ProductSwap[] {
  const tight = strategies.find(item => item.listingId === 'featured-tight-market')
  const defensive = strategies.find(item => item.listingId === 'featured-defensive-market')
  if (!tight || !defensive) throw new Error('product swap plan requires Tight Market and Defensive Market')
  const request = (item: ProductStrategy, requestId: string): ProductSwap['request'] => ({
    schema: 'aqua-execution-v1', requestId, sessionId: item.request.sessionId, action: 'swap',
    expectedStrategyHash: item.strategyHash, tokenIn: item.request.strategy.tokens[1]!, amountIn: '250000', slippageBps: 50,
  })
  return [
    { file: '01-tight-market-active.swap.json', expected: 'success', request: request(tight, 'swap-tight-before-switch') },
    { file: '02-defensive-market-active.swap.json', expected: 'success', request: request(defensive, 'swap-defensive-after-switch') },
    { file: '03-tight-market-inactive.swap.json', expected: 'guard-rejection', request: request(tight, 'swap-tight-after-switch') },
  ]
}
