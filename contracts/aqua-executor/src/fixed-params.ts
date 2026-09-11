import { erc20Abi, parseUnits } from 'viem'
import type { Ctx } from './config.ts'
import type { AquaStrategyParams, Deployment, Hex } from './types.ts'

/** Shape of params/fixed.json. */
export interface FixedTemplate {
  tokens: string[]
  amounts: string[]
  feeBps: number
  ttlSec: number
  strategyVersion: number
  rebalanceFeeBps: number
  demoSwap: { tokenIn: string; amountIn: string; slippageBps: number }
}

/**
 * Milestone-1 stand-in for the TEE agent: fixed template -> AquaStrategyParams.
 * Swap this for the TEE output later; nothing downstream changes.
 */
export async function fixedParams(
  ctx: Ctx,
  d: Deployment,
  t: FixedTemplate,
  o: { revision: number; salt: bigint; amounts?: bigint[]; feeBps?: number },
): Promise<AquaStrategyParams> {
  const tokens = t.tokens.map(sym => tokenAddress(d, sym))
  const amounts = o.amounts ?? (await Promise.all(tokens.map(async (tk, i) => parseUnits(t.amounts[i]!, await decimals(ctx, tk)))))
  const { timestamp } = await ctx.pc.getBlock()
  return {
    schema: 'aqua-swapvm-v1.0.2',
    chainId: d.chainId,
    maker: ctx.maker.account.address,
    tokens,
    amounts: amounts.map(String),
    program: { kind: 'xyc', feeBps: o.feeBps ?? t.feeBps, deadline: Number(timestamp) + t.ttlSec, salt: o.salt.toString() },
    meta: { producer: 'fixed-params', strategyVersion: t.strategyVersion, paramsRevision: o.revision },
  }
}

export function tokenAddress(d: Deployment, symbol: string): Hex {
  const a = d.tokens[symbol]
  if (!a) throw new Error(`token ${symbol} not in deployment (have: ${Object.keys(d.tokens).join(', ')})`)
  return a
}

export const decimals = (ctx: Ctx, token: Hex) => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
