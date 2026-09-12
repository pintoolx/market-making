import { bytesToHex, type Runtime } from '@chainlink/cre-sdk'
import { keccak256, stringToHex } from 'viem'
import { z } from 'zod'
import { configSchema } from './market-data/config'
import { observeWallet } from './market-data/observe'
import defaults from './market-data/defaults.json'
import { marketSnapshotSchema } from './types'

export const scenarioIdSchema = z.enum(['normal-v1', 'stress-v1'])
export const MARKET_SCENARIOS = {
  'normal-v1': { midPrice: '2520', volatilityBps: 20 },
  'stress-v1': { midPrice: '2520', volatilityBps: 400 },
} as const

/** Synthetic prices only. Balances, decimals and block identity are acquired from Sepolia. */
export function acquireScenarioMarket(runtime: Runtime<unknown>, maker: string, inputId: string) {
  const scenarioId = scenarioIdSchema.parse(inputId)
  const { weth, usdc, height, header } = observeWallet(runtime, configSchema.parse({ ...defaults, maker }))
  const market = marketSnapshotSchema.parse({ ...MARKET_SCENARIOS[scenarioId],
    balance0: weth.balanceAtomic, balance1: usdc.balanceAtomic, decimals0: weth.decimals, decimals1: usdc.decimals })
  const observation = { source: 'synthetic-scenario' as const, scenarioId,
    method: 'rss-simple-returns-30m-v1', inputKind: 'specified-summary-values',
    maker: maker.toLowerCase(), chainId: 11155111, balanceSource: 'finalized-sepolia-wallet',
    blockNumber: height.toString(), blockHash: bytesToHex(header.hash),
    blockTimestamp: header.timestamp.toString(), market }
  return { market, evidence: { observation, inputDigest: keccak256(stringToHex(JSON.stringify(observation))) } }
}
