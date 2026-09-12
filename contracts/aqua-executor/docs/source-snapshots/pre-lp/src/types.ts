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
  program: {
    /** Constant product x*y=k with a flat fee taken from amountIn. */
    kind: 'xyc'
    feeBps: number
    /** Unix seconds. */
    deadline: number
    /** uint64. A new salt gives a new strategyHash, which is required to ship again after a dock. */
    salt: string
  }
  meta: { producer: 'fixed-params' | 'tee'; strategyVersion: number; paramsRevision: number }
}

/** deployments/<chainId>.json */
export interface Deployment {
  chainId: number
  aqua: Hex
  router: Hex
  /** symbol -> address */
  tokens: Record<string, Hex>
}
