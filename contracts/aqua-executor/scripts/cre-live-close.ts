// Post-demo cleanup: the executor's dock revokes Maker allowances; the taker's
// allowance left by an intentionally reverted swap is closed here, durably.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { BaseError, erc20Abi, parseAbi, zeroHash } from 'viem'
import { fromEnv, loadDeployment } from '../src/config.ts'
import { canonical, executionId } from '../src/execution-request.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { ExecutionStore, json } from '../src/execution-store.ts'
import { durableSender } from '../src/durable-send.ts'
import { buildTx, rawBalances } from '../src/executor.ts'
import type { AquaStrategyParams, Deployment } from '../src/types.ts'

async function main() {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, out: { type: 'string' }, execute: { type: 'boolean', default: false } } })
  if (!values.plan || !values.out) throw new Error('Use --plan <public plan.json> --out <public proof.json>; add --execute to revoke outstanding demo allowances')
  const plan = JSON.parse(readFileSync(values.plan, 'utf8')) as { sessionId: string; stateDir: string; deployment: Deployment; strategy: AquaStrategyParams }
  const ctx = fromEnv('ethereum-sepolia'), d = loadDeployment(11155111), s = compileExecution(plan.strategy)
  executionId(plan.sessionId)
  if (canonical(plan.deployment) !== canonical(d) || resolve(plan.stateDir) !== fileURLToPath(new URL(`../.state/sepolia/${ctx.maker.account.address.toLowerCase()}/`, import.meta.url)).replace(/\/$/, '') ||
    plan.strategy.maker.toLowerCase() !== ctx.maker.account.address.toLowerCase() || await ctx.pc.getChainId() !== 11155111) throw new Error('Cleanup domain mismatch')
  if ((await rawBalances(ctx, d, s)).some(x => x.tokensCount !== 255 || x.balance !== 0n)) throw new Error('Dock the demo before revoking allowances')
  const active = await ctx.pc.readContract({ address: d.guard!.address, abi: parseAbi(['function activeStrategyHash(address) view returns (bytes32)']), functionName: 'activeStrategyHash', args: [ctx.maker.account.address] })
  if (active !== zeroHash) throw new Error('Pause the Maker strategy before final cleanup')
  const requestId = `${plan.sessionId}-cleanup`, store = new ExecutionStore(plan.stateDir)
  try {
    const rec = store.recorder(requestId, 11155111, ctx.explorer), sender = durableSender(ctx, store, requestId, rec)
    const transactions = [], allowances = []
    for (const [index, token] of s.tokens.entries()) for (const [role, wallet, spender] of [['maker', ctx.maker, d.aqua], ['taker', ctx.taker, d.router]] as const) {
      const step = `${role}-revoke-${index}`
      let allowance = await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, spender] })
      if (values.execute && (allowance !== 0n || sender.get(step))) {
        const receipt = await sender.send(step, wallet, 'demo-allowance-revoke', s.strategyHash, async () => buildTx.approve(token, spender, 0n))
        transactions.push({ hash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), status: receipt.status, role, token })
        allowance = await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, spender] })
      }
      allowances.push({ role, token, owner: wallet.account.address, spender, allowance: allowance.toString() })
    }
    const result = { chainId: 11155111, strategyHash: s.strategyHash, activeStrategyHash: active, broadcastEnabled: values.execute, transactions, allowances }
    if (values.execute && allowances.some(a => a.allowance !== '0')) throw new Error('Cleanup allowance readback failed')
    writeFileSync(values.out, json(result) + '\n')
    console.log(json(result))
  } finally { store.export(requestId); store.close() }
}
main().catch(e => { console.error(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : 'Cleanup failed'); process.exitCode = 1 })
