export type Hex = `0x${string}`

/**
 * One maker's final market-making strategy: the hand-off contract between the TEE agent and this executor.
 * Milestone 1 builds it from params/fixed.json (src/fixed-params.ts); the TEE agent will emit the same shape.
 *
 * Maker risk limits map onto it:
 * - `amounts` is the capital cap per token: Aqua only pulls against the virtual balance, so the maker's net outflow
 *   of a token can never exceed what was shipped (inflows from swaps can be paid back out).
 * - `program.deadline` is the expiry; the strategy stops quoting after it.
 * - Max tolerable loss has no opcode in router v1.0.2. monitor.ts docks using a separate RiskPolicy and price provider.
 */
export interface AquaStrategyParams {
  /** Pins the deployed router's opcode table and ABI (swap-vm v1.0.2, NOT swap-vm main). */
  schema: 'aqua-swapvm-v1.0.2'
  chainId: number
  maker: Hex
  /** Exact token list shipped, and later docked. */
  tokens: Hex[]
  /** Raw units, same order as `tokens`. */
  amounts: string[]
  program: StrategyProgram
  /** Explicit, reconstructible Guard recipe; specialized compiled markers remain rejected. */
  guard?: { address: Hex; version: 1 | 2; caps: {
    maxAmount0PerSwap: string; maxAmount1PerSwap: string; maxPostBalance0: string; maxPostBalance1: string
  } }
  meta: { producer: 'fixed-params' | 'tee'; strategyVersion: number; paramsRevision: number }
}

/** deployments/<chainId>.json */
export interface Deployment {
  chainId: number
  aqua: Hex
  router: Hex
  /** symbol -> address */
  tokens: Record<string, Hex>
  /** Optional delivery receiver; synthetic demo receivers are recorded separately. */
  guard?: { address: Hex; version: 2; revision?: 'maker-active-v1' | 'standing-v2'; forwarder: Hex; profile: 'cre-simulation' | 'cre-production' }

}

export interface ProgramCommon {
  feeBps: number
  /** Unix seconds. */
  deadline: number
  /** uint64; never reuse after docking. */
  salt: string
}
export type StrategyProgram = ProgramCommon & (
  | { kind: 'xyc' }
  | { kind: 'concentrated'; sqrtPriceMin: string; sqrtPriceMax: string }
  | {
    kind: 'pegged'
    /** A in 1e27 fixed point, between 0 and 5000e27. */
    linearWidth: string
    /** Raw reference balances and normalization multipliers, in tokens[] order. */
    referenceBalances: [string, string]
    rates: [string, string]
  }
)
