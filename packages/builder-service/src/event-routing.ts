import { decodeEventLog, parseAbi, type Hex } from 'viem'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import type { PublicEvent } from './event-delivery.ts'

// Signatures pinned by contracts/aqua-executor/src/abi.ts and AquaGuardV2.sol.
const aqua = parseAbi([
  'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
  'event Docked(address maker,address app,bytes32 strategyHash)',
  'event Pulled(address maker,address app,bytes32 strategyHash,address token,uint256 amount)',
  'event Pushed(address maker,address app,bytes32 strategyHash,address token,uint256 amount)',
])
const guard = parseAbi([
  'event ReportAccepted(address indexed maker,bytes32 indexed strategyHash,uint64 nonce,bytes32 digest,uint48 validUntil)',
  'event ActiveStrategyChanged(address indexed maker,bytes32 indexed previousStrategyHash,bytes32 indexed strategyHash)',
  'event StrategyRevocationChanged(address indexed maker,bytes32 indexed strategyHash,bool revoked)',
])
const token = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event Approval(address indexed owner,address indexed spender,uint256 value)'])
const router = parseAbi(['event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)'])
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Source authentication precedes this routing filter. Events only request
 * reevaluation; amounts/prices/caps in their payload are never authoritative. */
export function eventMatchesInstance(event: PublicEvent, profile: DeploymentProfile, maker: string, strategyHash: string) {
  if (event.chainId === undefined && event.kind !== 'evm.log') return true
  if (event.chainId !== profile.chainId || !event.transactionHash || !event.blockHash || event.logIndex === undefined) return false
  const { address, topics, data } = event.payload
  if (typeof address !== 'string' || !Array.isArray(topics) || !topics.length || topics.some(t => typeof t !== 'string' || !/^0x[0-9a-f]{64}$/i.test(t)) ||
    typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) return false
  const abi = same(address, profile.aqua) ? aqua : same(address, profile.guard) ? guard : same(address, profile.router) ? router :
    profile.tokens.some(t => same(address, t.address)) ? token : undefined
  if (!abi) return false
  try {
    const log = decodeEventLog({ abi, data: data as Hex, topics: topics as [Hex, ...Hex[]], strict: true })
    const args = log.args as Record<string, unknown>
    if (log.eventName === 'Transfer') return same(args.from, maker) || same(args.to, maker)
    if (log.eventName === 'Approval') return same(args.owner, maker) && same(args.spender, profile.aqua)
    if (!same(args.maker, maker)) return false
    if (log.eventName === 'ActiveStrategyChanged') return same(args.strategyHash, strategyHash) || same(args.previousStrategyHash, strategyHash)
    if (same(address, profile.aqua) && !same(args.app, profile.router)) return false
    return same(args.strategyHash ?? args.orderHash, strategyHash)
  } catch { return false }
}
