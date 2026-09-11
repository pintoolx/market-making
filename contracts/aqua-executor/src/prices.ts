import { createPublicClient, http, isAddress, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { MonitorDataError, type PriceSnapshot } from './risk.ts'
import type { Deployment, Hex } from './types.ts'

// Official Chainlink Base USD proxies. ETH is the standard secondary proxy of the shared SVR feed.
// https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json
export const BASE_USD_FEEDS = [
  { address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', description: 'ETH / USD', maxAgeSec: 1320 },
  { address: '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B', description: 'USDC / USD', maxAgeSec: 86520 },
] as const
export const LIVE_MAX_PRICE_AGE_SEC = 86520
export const BASE_SEQUENCER = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433'
export const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
])
export type OracleRound = readonly [bigint, bigint, bigint, bigint, bigint]
export interface OracleSample {
  chainId: number
  blockNumber: bigint
  blockTimestamp: bigint
  sequencer: OracleRound
  feeds: { round: OracleRound; decimals: number; description: string }[]
}

/** Pure validation/normalization. Preserve round timestamps, including the 24h USDC heartbeat. */
export function chainlinkSnapshot(tokens: Hex[], data: OracleSample, now: number): PriceSnapshot {
  const fail = (message: string): never => { throw new MonitorDataError(message) }
  if (tokens.length !== 2 || tokens.some(t => !isAddress(t, { strict: false })) || new Set(tokens.map(t => t.toLowerCase())).size !== 2) {
    throw new Error('Chainlink mapping requires distinct ETH and USDC token addresses')
  }
  if (data.chainId !== 8453) fail('oracle RPC chainId is not Base mainnet')
  if (data.blockTimestamp > BigInt(now + 5) || BigInt(now) - data.blockTimestamp > 60n) fail('oracle chain snapshot is stale or in the future')
  const [, answer, startedAt] = data.sequencer
  if (answer !== 0n || startedAt <= 0n || BigInt(now) - startedAt <= 3600n) fail('Base sequencer is down or within its recovery grace period')
  if (data.feeds.length !== 2) fail('oracle response is missing a feed')
  const usdE8: Record<Hex, string> = {}
  const observations = data.feeds.map((feed, i) => {
    const config = BASE_USD_FEEDS[i]!
    const [roundId, price, , updatedAt] = feed.round
    if (feed.description !== config.description) fail(`wrong feed description: expected ${config.description}`)
    if (roundId <= 0n || price <= 0n || updatedAt <= 0n || updatedAt > BigInt(now)) fail(`invalid ${config.description} round`)
    if (BigInt(now) - updatedAt > BigInt(config.maxAgeSec)) fail(`stale ${config.description} round`)
    if (!Number.isInteger(feed.decimals) || feed.decimals < 0 || feed.decimals > 18) fail('unsupported oracle decimals')
    const normalized = feed.decimals <= 8 ? price * 10n ** BigInt(8 - feed.decimals) : price / 10n ** BigInt(feed.decimals - 8)
    if (normalized <= 0n) fail('oracle price rounds to zero')
    usdE8[tokens[i]!] = normalized.toString()
    return { token: tokens[i], proxy: config.address, roundId: roundId.toString(), updatedAt: Number(updatedAt), answer: price.toString(), decimals: feed.decimals, maxAgeSec: config.maxAgeSec }
  })
  return {
    asOf: Math.min(...observations.map(f => f.updatedAt)), source: 'Chainlink Base mainnet ETH/USD and USDC/USD', mode: 'live', usdE8,
    evidence: { chainId: 8453, blockNumber: data.blockNumber.toString(), blockTimestamp: Number(data.blockTimestamp), fetchedAt: now, sequencerProxy: BASE_SEQUENCER, sequencerStartedAt: startedAt.toString(), observations },
  }
}

/** Read-only mainnet oracle access. Testnet mock tokens are explicitly mapped to ETH/USDC references. */
export function createChainlinkPrices(d: Deployment, o: { rpcUrls?: string[] } = {}) {
  const tokens = [d.tokens.mWETH ?? d.tokens.WETH, d.tokens.mUSDC ?? d.tokens.USDC]
  if (tokens.some(t => !t)) throw new Error('deployment needs mWETH/mUSDC or WETH/USDC for the Chainlink mapping')
  const rpcUrls = o.rpcUrls ?? (process.env.BASE_PRICE_RPC_URLS?.split(',').map(s => s.trim()).filter(Boolean) ?? ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'])
  if (!rpcUrls.length) throw new Error('at least one oracle RPC URL is required')
  const clients = rpcUrls.map(url => createPublicClient({ chain: base, transport: http(url, { timeout: 8000, retryCount: 0 }) }))
  return async (): Promise<PriceSnapshot> => {
    const failures: string[] = []
    for (const [index, pc] of clients.entries()) {
      try {
        const [chainId, block] = await Promise.all([pc.getChainId(), pc.getBlock({ blockTag: 'latest' })])
        // One multicall for both prices, decimals, descriptions and sequencer at the same block.
        const values = await pc.multicall({ allowFailure: false, blockNumber: block.number, contracts: [
          { address: BASE_SEQUENCER, abi: aggregatorAbi, functionName: 'latestRoundData' },
          ...BASE_USD_FEEDS.flatMap(f => (['latestRoundData', 'decimals', 'description'] as const).map(functionName => ({ address: f.address as Hex, abi: aggregatorAbi, functionName }))),
        ] })
        const feeds = BASE_USD_FEEDS.map((_, i) => ({ round: values[1 + 3 * i] as OracleRound, decimals: values[2 + 3 * i] as number, description: values[3 + 3 * i] as string }))
        return chainlinkSnapshot(tokens as Hex[], { chainId, blockNumber: block.number, blockTimestamp: block.timestamp, sequencer: values[0] as OracleRound, feeds }, Math.floor(Date.now() / 1000))
      } catch (e) {
        // Do not put RPC URLs (which can contain credentials) into public execution records.
        failures.push(`endpoint ${index + 1}: ${e instanceof MonitorDataError ? e.message : 'RPC read failed'}`)
      }
    }
    throw new MonitorDataError(`Chainlink unavailable (${failures.join('; ')})`)
  }
}
