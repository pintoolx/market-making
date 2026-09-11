import { createRequire } from 'node:module'
import { keccak256 } from 'viem'
import type { AquaStrategyParams, Hex } from './types.ts'

// ponytail: the SDK's ESM build fails on Node 24 (ERR_MODULE_NOT_FOUND inside @1inch/byte-utils); its CJS build works.
// Encoding targets the DEPLOYED router v1.0.2 opcode table (swap-vm `main` differs); test/compile.test.ts pins the bytes.
const S = createRequire(import.meta.url)('@1inch/swap-vm-sdk')

export interface Compiled {
  params: AquaStrategyParams
  /** SwapVM Order; `data` is the program bytecode. */
  order: { maker: Hex; traits: bigint; data: Hex }
  /** abi.encode(order): the bytes Aqua.ship stores. */
  strategy: Hex
  /** keccak256(strategy), which equals router.hash(order). */
  strategyHash: Hex
  tokens: Hex[]
  amounts: bigint[]
}

export function compile(p: AquaStrategyParams): Compiled {
  if (p.schema !== 'aqua-swapvm-v1.0.2') throw new Error(`unsupported schema: ${p.schema}`)
  if (p.program.kind !== 'xyc') throw new Error(`unsupported program: ${p.program.kind}`)
  if (p.tokens.length !== 2 || p.amounts.length !== 2) throw new Error('xyc needs exactly 2 tokens and 2 amounts')
  if (p.tokens[0]!.toLowerCase() === p.tokens[1]!.toLowerCase()) throw new Error('duplicate token')
  const amounts = p.amounts.map(a => BigInt(a))
  if (amounts.some(a => a <= 0n)) throw new Error('amounts must be > 0')
  const { feeBps, deadline, salt } = p.program
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new Error(`bad feeBps: ${feeBps}`)

  const program = new S.AquaProgramBuilder()
    .deadline({ deadline: BigInt(deadline) })
    .flatFeeAmountInXD({ fee: BigInt(feeBps) * 100_000n }) // v1.0.2 fee scale: 1e9 = 100%
    .xycSwapXD()
    .salt({ salt: BigInt(salt) })
    .build()
  // MakerTraits.default() = useAquaInsteadOfSignature only (no hooks, custom receiver or unwrap)
  const order = S.Order.new({ maker: new S.Address(p.maker), program, traits: S.MakerTraits.default() })
  const strategy: Hex = order.encode().toString()
  return { params: p, order: order.build(), strategy, strategyHash: keccak256(strategy), tokens: p.tokens, amounts }
}

/**
 * Taker config: exact-in with a min-out threshold. `useTransferFromAndAquaPush` makes the router transferFrom the taker
 * and push into Aqua itself, so a plain EOA can swap (no callback contract). `deadline` 0 = none.
 */
export function takerTraits(minAmountOut: bigint, deadline = 0n): Hex {
  return S.TakerTraits.new({ exactIn: true, useTransferFromAndAquaPush: true, threshold: minAmountOut, deadline }).encode().toString()
}
