import { setTimeout as sleep } from 'node:timers/promises'
import { BaseError, decodeErrorResult, encodeFunctionData, erc20Abi, type TransactionReceipt } from 'viem'
import { aquaAbi, errorsAbi, routerAbi } from './abi.ts'
import { takerTraits, type Compiled } from './compile.ts'
import type { Ctx, Wallet } from './config.ts'
import { decodeEvents, type Recorder } from './records.ts'
import type { Deployment, Hex } from './types.ts'

/** Aqua's tokensCount marker for a docked strategy. */
export const DOCKED = 0xff

/** Unsigned tx. Every state change is built here, so a wallet / TEE signer can replace `send` without touching the rest. */
export interface TxRequest {
  to: Hex
  data: Hex
}

export const buildTx = {
  approve: (token: Hex, spender: Hex, amount: bigint): TxRequest => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  }),
  ship: (d: Deployment, s: Compiled): TxRequest => ({
    to: d.aqua,
    data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [d.router, s.strategy, s.tokens, s.amounts] }),
  }),
  dock: (d: Deployment, s: Compiled, tokens = s.tokens): TxRequest => ({
    to: d.aqua,
    data: encodeFunctionData({ abi: aquaAbi, functionName: 'dock', args: [d.router, s.strategyHash, tokens] }),
  }),
  /** dock(old) + ship(new) atomically. AquaRouter.multicall delegatecalls itself, so msg.sender stays the maker. */
  rebalance: (d: Deployment, from: Compiled, to: Compiled): TxRequest => ({
    to: d.aqua,
    data: encodeFunctionData({ abi: aquaAbi, functionName: 'multicall', args: [[buildTx.dock(d, from).data, buildTx.ship(d, to).data]] }),
  }),
  swap: (d: Deployment, s: Compiled, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, traits: Hex): TxRequest => ({
    to: d.router,
    data: encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [s.order, tokenIn, tokenOut, amountIn, traits] }),
  }),
}

/**
 * Receipt, and 'latest' includes it. Base's flashblocks RPC hands out receipts before 'latest' has the tx,
 * so without the second wait the next read / simulation sees pre-tx state.
 */
export async function waitMined(ctx: Ctx, hash: Hex): Promise<TransactionReceipt> {
  const r = await ctx.pc.waitForTransactionReceipt({ hash })
  while ((await ctx.pc.getBlockNumber({ cacheTime: 0 })) < r.blockNumber) await sleep(250)
  return r
}

/** Simulate, sign, send, wait, record. The only signing path for lifecycle txs (deploy.ts signs its deploys directly). */
export async function send(ctx: Ctx, w: Wallet, req: TxRequest, action: string, rec: Recorder, strategyHash?: Hex): Promise<TransactionReceipt> {
  try {
    await ctx.pc.call({ account: w.account.address, to: req.to, data: req.data })
  } catch (e) {
    throw new Error(`${action} would revert: ${revertReason(e)}`, { cause: e })
  }
  const hash = await w.sendTransaction({ to: req.to, data: req.data })
  const receipt = await waitMined(ctx, hash)
  rec.execution(action, receipt, strategyHash)
  if (receipt.status !== 'success') throw new Error(`${action} reverted on-chain: ${hash}`)
  return receipt
}

export function revertReason(e: unknown): string {
  if (!(e instanceof BaseError)) return String(e)
  const data = (e.walk(x => typeof (x as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data
  if (!data) return e.shortMessage
  try {
    const r = decodeErrorResult({ abi: errorsAbi, data })
    return `${r.errorName}(${(r.args ?? []).join(', ')})`
  } catch {
    return `unknown revert ${data.slice(0, 10)}`
  }
}

const erc20 = (ctx: Ctx, token: Hex) => ({
  balanceOf: (a: Hex) => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
  allowance: (a: Hex, spender: Hex) => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [a, spender] }),
})

export async function rawBalances(ctx: Ctx, d: Deployment, s: Compiled, blockNumber?: bigint) {
  return Promise.all(
    s.tokens.map(async token => {
      const [balance, tokensCount] = await ctx.pc.readContract({
        address: d.aqua,
        abi: aquaAbi,
        functionName: 'rawBalances',
        args: [s.params.maker, d.router, s.strategyHash, token],
        blockNumber,
      })
      return { token, balance, tokensCount }
    }),
  )
}

/** Post-condition: every token slot has tokensCount === expected (tokens.length after ship, DOCKED after dock). */
export async function expectState(ctx: Ctx, d: Deployment, s: Compiled, expected: number, rec: Recorder, label: string) {
  const balances = await rawBalances(ctx, d, s)
  rec.write({ kind: 'check', label, strategy_hash: s.strategyHash, raw_balances: balances })
  const bad = balances.filter(b => b.tokensCount !== expected)
  if (bad.length) throw new Error(`${label}: tokensCount [${bad.map(b => b.tokensCount)}] != ${expected}`)
  return balances
}

/** Aqua.ship checks no real funds: a strategy the maker can't back only fails later, inside the taker's swap. */
export async function shipPreflight(ctx: Ctx, d: Deployment, s: Compiled) {
  const maker = s.params.maker
  if (maker.toLowerCase() !== ctx.maker.account.address.toLowerCase()) {
    throw new Error(`strategy maker ${maker} is not the signer: Aqua keys balances by msg.sender`)
  }
  const onChainHash = await ctx.pc.readContract({ address: d.router, abi: routerAbi, functionName: 'hash', args: [s.order] })
  if (onChainHash !== s.strategyHash) throw new Error(`router.hash(order) ${onChainHash} != keccak256(strategy) ${s.strategyHash}: wrong router version?`)

  const problems: string[] = []
  for (const [i, token] of s.tokens.entries()) {
    const need = s.amounts[i]!
    const [bal, allowance] = await Promise.all([erc20(ctx, token).balanceOf(maker), erc20(ctx, token).allowance(maker, d.aqua)])
    if (bal < need) problems.push(`${token}: maker balance ${bal} < ${need}`)
    if (allowance < need) problems.push(`${token}: allowance to Aqua ${allowance} < ${need}`)
  }
  if (problems.length) throw new Error(`ship preflight failed:\n  ${problems.join('\n  ')}`)
}

export async function quote(ctx: Ctx, d: Deployment, s: Compiled, tokenIn: Hex, tokenOut: Hex, amountIn: bigint) {
  const [qIn, qOut] = await ctx.pc.readContract({
    address: d.router,
    abi: routerAbi,
    functionName: 'quote',
    args: [s.order, tokenIn, tokenOut, amountIn, takerTraits(0n)],
    account: ctx.taker.account.address,
  })
  return { amountIn: qIn, amountOut: qOut }
}

/** Taker EOA: quote -> approve router (not Aqua) -> swap with a min-out threshold. */
export async function takerSwap(ctx: Ctx, d: Deployment, s: Compiled, tokenIn: Hex, amountIn: bigint, slippageBps: number, rec: Recorder) {
  if (!s.tokens.some(t => t.toLowerCase() === tokenIn.toLowerCase())) throw new Error(`${tokenIn} is not in the strategy`)
  const tokenOut = s.tokens.find(t => t.toLowerCase() !== tokenIn.toLowerCase())!
  const q = await quote(ctx, d, s, tokenIn, tokenOut, amountIn)

  // The quote reads virtual balances only; the swap pulls tokenOut from the maker's real wallet.
  const [bal, allowance] = await Promise.all([erc20(ctx, tokenOut).balanceOf(s.params.maker), erc20(ctx, tokenOut).allowance(s.params.maker, d.aqua)])
  if (bal < q.amountOut || allowance < q.amountOut) {
    throw new Error(`maker can't cover ${q.amountOut} of ${tokenOut}: balance ${bal}, allowance to Aqua ${allowance}`)
  }

  const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  const { timestamp } = await ctx.pc.getBlock()
  await send(ctx, ctx.taker, buildTx.approve(tokenIn, d.router, amountIn), 'taker-approve', rec)
  const r = await send(ctx, ctx.taker, buildTx.swap(d, s, tokenIn, tokenOut, amountIn, takerTraits(minOut, timestamp + 300n)), 'swap', rec, s.strategyHash)
  const ev = decodeEvents(r.logs, [d.router]).find(e => e.event === 'Swapped')
  if (!ev) throw new Error(`swap ${r.transactionHash} emitted no Swapped event`)
  return { tokenIn, tokenOut, quote: q, minOut, amountIn: ev.args.amountIn as bigint, amountOut: ev.args.amountOut as bigint, txHash: r.transactionHash }
}
