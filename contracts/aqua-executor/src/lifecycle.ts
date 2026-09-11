import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { keccak256, parseUnits, stringToHex } from 'viem'
import { compile } from './compile.ts'
import { fromEnv, loadDeployment, readJson, RECORDS_DIR, type Ctx } from './config.ts'
import { buildTx, DOCKED, expectState, rawBalances, send, shipPreflight, takerSwap } from './executor.ts'
import { decimals, fixedParams, tokenAddress, type FixedTemplate } from './fixed-params.ts'
import { recorder, runStamp } from './records.ts'
import type { Deployment } from './types.ts'

/** uint64 salt, unique per run + params revision (a docked strategyHash can never be shipped again). */
const saltFor = (runId: string, revision: number) => BigInt(keccak256(stringToHex(`${runId}:${revision}`)).slice(0, 18))

/**
 * maker approve -> ship -> taker swap -> [rebalance -> taker swap] -> dock -> revoke.
 * Every tx lands in records/<chainId>/<runId>.jsonl.
 */
export async function runLifecycle(ctx: Ctx, d: Deployment, o: { rebalance?: boolean; runId?: string; recordsDir?: string } = {}) {
  const runId = o.runId ?? runStamp()
  const t: FixedTemplate = readJson('params/fixed.json')
  const rec = recorder({ dir: o.recordsDir ?? RECORDS_DIR, runId, chainId: d.chainId, explorer: ctx.explorer })
  const started_at = new Date().toISOString()
  const strategies: { hash: string; params: unknown }[] = []
  const swaps: Awaited<ReturnType<typeof takerSwap>>[] = []
  try {
    // 1. strategy params -> SwapVM order. The TEE agent's output replaces fixedParams() later.
    const s1 = compile(await fixedParams(ctx, d, t, { revision: 1, salt: saltFor(runId, 1) }))
    strategies.push({ hash: s1.strategyHash, params: s1.params })

    // 2. maker approval: Aqua (not the router) is the spender, for exactly the shipped amounts.
    // ponytail: exact approvals suit this demo. Every pull spends the maker's allowance and pushes never refill it,
    // so a long-lived strategy needs allowance >= cumulative outflow per token (in practice: max allowance or a top-up loop).
    for (const [i, token] of s1.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s1.amounts[i]!), 'maker-approve', rec)

    // 3. ship: pure accounting, no tokens move.
    await shipPreflight(ctx, d, s1)
    await send(ctx, ctx.maker, buildTx.ship(d, s1), 'ship', rec, s1.strategyHash)
    await expectState(ctx, d, s1, s1.tokens.length, rec, 'after ship')

    // 4. taker swap: Aqua pulls tokenOut from the maker's wallet and pushes tokenIn into it.
    const tokenIn = tokenAddress(d, t.demoSwap.tokenIn)
    const amountIn = parseUnits(t.demoSwap.amountIn, await decimals(ctx, tokenIn))
    swaps.push(await takerSwap(ctx, d, s1, tokenIn, amountIn, t.demoSwap.slippageBps, rec))
    let active = s1

    // 5. rebalance (M4): dock(old) + ship(new fee, current inventory) in one maker tx.
    if (o.rebalance) {
      const inventory = (await rawBalances(ctx, d, s1)).map(b => b.balance)
      const s2 = compile(await fixedParams(ctx, d, t, { revision: 2, salt: saltFor(runId, 2), amounts: inventory, feeBps: t.rebalanceFeeBps }))
      strategies.push({ hash: s2.strategyHash, params: s2.params })
      for (const [i, token] of s2.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, s2.amounts[i]!), 'maker-approve', rec)
      await shipPreflight(ctx, d, s2)
      await send(ctx, ctx.maker, buildTx.rebalance(d, s1, s2), 'rebalance', rec, s2.strategyHash)
      await expectState(ctx, d, s1, DOCKED, rec, 'old strategy after rebalance')
      await expectState(ctx, d, s2, s2.tokens.length, rec, 'new strategy after rebalance')
      swaps.push(await takerSwap(ctx, d, s2, tokenIn, amountIn, t.demoSwap.slippageBps, rec))
      active = s2
    }

    // 6. dock: accounting only, tokens stay in the maker's wallet. Then revoke the leftover allowance.
    await send(ctx, ctx.maker, buildTx.dock(d, active), 'dock', rec, active.strategyHash)
    await expectState(ctx, d, active, DOCKED, rec, 'after dock')
    for (const token of active.tokens) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'maker-revoke', rec)

    rec.write({ kind: 'cycle', status: 'completed', started_at, strategies, swaps })
    return { file: rec.file, strategies, swaps }
  } catch (e) {
    rec.write({ kind: 'cycle', status: 'failed', started_at, strategies, swaps, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { network: { type: 'string', default: 'local' }, rebalance: { type: 'boolean', default: false } } })
  const ctx = fromEnv(values.network)
  const out = await runLifecycle(ctx, loadDeployment(ctx.chain.id), { rebalance: values.rebalance })
  for (const line of readFileSync(out.file, 'utf8').trim().split('\n').map(l => JSON.parse(l))) {
    if (line.kind === 'execution') console.log(`${line.action.padEnd(14)} ${line.status.padEnd(8)} gas ${String(line.gas_used).padStart(7)}  ${line.explorer_url ?? line.tx_hash}`)
  }
  for (const s of out.swaps) console.log(`swap: ${s.amountIn} in -> ${s.amountOut} out (quote ${s.quote.amountOut}, min ${s.minOut})`)
  console.log(`records: ${out.file}`)
}
