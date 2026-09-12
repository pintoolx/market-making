// Narrow, resumable testnet evidence step: mine exactly one DirectionDisabled
// swap after a real CRE report has disabled USDC-in. No contract deployment.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { BaseError, TransactionReceiptNotFoundError, decodeErrorResult, erc20Abi, keccak256, type Abi, type TransactionReceipt } from 'viem'
import { fromEnv, loadDeployment } from '../src/config.ts'
import { canonical, executionId } from '../src/execution-request.ts'
import { compileExecution } from '../src/execution-compile.ts'
import { ExecutionStore, json } from '../src/execution-store.ts'
import { durableSender, type SavedTransaction } from '../src/durable-send.ts'
import { buildTx, rawBalances, waitMined } from '../src/executor.ts'
import { aquaAbi } from '../src/abi.ts'
import { takerTraits } from '../src/compile.ts'
import type { AquaStrategyParams, Deployment, Hex } from '../src/types.ts'

async function main() {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, execute: { type: 'boolean', default: false }, out: { type: 'string' } } })
  if (!values.plan || !values.out) throw new Error('Use --plan <public plan.json> --out <public proof.json>; add --execute to mine the rejected test swap')
  const plan = JSON.parse(readFileSync(values.plan, 'utf8')) as { sessionId: string; stateDir: string; deployment: Deployment; strategy: AquaStrategyParams; strategyHash: Hex }
  const d = plan.deployment, s = compileExecution(plan.strategy), ctx = fromEnv('ethereum-sepolia')
  executionId(plan.sessionId)
  if (canonical(d) !== canonical(loadDeployment(11155111)) || resolve(plan.stateDir) !== fileURLToPath(new URL(`../.state/sepolia/${ctx.maker.account.address.toLowerCase()}/`, import.meta.url)).replace(/\/$/, '')) throw new Error('Plan must use the confirmed deployment and shared signer journal')
  if (s.strategyHash !== plan.strategyHash || d.chainId !== 11155111 || await ctx.pc.getChainId() !== 11155111 ||
    ctx.maker.account.address.toLowerCase() !== plan.strategy.maker.toLowerCase() || d.guard?.profile !== 'cre-simulation') throw new Error('Demo domain mismatch')
  const guardAbi = JSON.parse(readFileSync(new URL('../artifacts/AquaGuardV2.json', import.meta.url), 'utf8')).abi as Abi
  const request = buildTx.swap(d, s, s.tokens[1]!, s.tokens[0]!, 500_000n, takerTraits(0n))
  const assertRejected = async () => {
    let reason: string | undefined
    try { await ctx.pc.call({ ...request, account: ctx.taker.account.address }) }
    catch (e) {
      if (!(e instanceof BaseError)) throw e
      const cause = e.walk(x => typeof (x as { data?: unknown }).data === 'string') as unknown as { data?: Hex }
      if (cause.data) reason = decodeErrorResult({ abi: guardAbi, data: cause.data }).errorName
    }
    if (reason !== 'DirectionDisabled') throw new Error('Expected exactly DirectionDisabled before broadcasting the test rejection')
  }
  if (!values.execute) { await assertRejected(); console.log(json({ status: 'eth_call rejected', reason: 'DirectionDisabled', broadcast: false })); return }
  const store = new ExecutionStore(plan.stateDir)
  const requestId = `${plan.sessionId}-rejection`
  const rec = store.recorder(requestId, 11155111, ctx.explorer)
  try {
    const sender = durableSender(ctx, store, requestId, rec)
    const savedKey = `${requestId}:expected-revert`
    let tx = store.get<SavedTransaction>('txs', savedKey)
    let receipt: TransactionReceipt | undefined
    if (tx) {
      if (tx.sender.toLowerCase() !== ctx.taker.account.address.toLowerCase() || tx.strategyHash !== s.strategyHash ||
        tx.request.to !== request.to || tx.request.data !== request.data || keccak256(tx.raw) !== tx.hash) throw new Error('Saved rejection does not match this plan')
      try { receipt = await ctx.pc.getTransactionReceipt({ hash: tx.hash }) }
      catch (e) { if (!(e instanceof TransactionReceiptNotFoundError)) throw e }
      if (tx.receipt && (!receipt || receipt.blockHash !== tx.receipt.blockHash || receipt.status !== tx.receipt.status)) throw new Error('Previously confirmed rejection receipt changed')
    }
    if (!receipt) {
      await assertRejected()
      await sender.send('approve', ctx.taker, 'taker-approve-for-rejection', s.strategyHash, async () => buildTx.approve(s.tokens[1]!, d.router, 500_000n))
      if (!tx) {
        const before = { aqua: (await rawBalances(ctx, d, s)).map(x => x.balance),
          wallet: await Promise.all(s.tokens.flatMap(address => [ctx.maker, ctx.taker].map(w => ctx.pc.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [w.account.address] })))) }
        store.put('cre-live-public-evidence', requestId, before)
        const nonce = await ctx.pc.getTransactionCount({ address: ctx.taker.account.address, blockTag: 'pending' })
        // Fixed gas intentionally bypasses estimation only for this verified revert.
        const prepared = await ctx.taker.prepareTransactionRequest({ ...request, gas: 500_000n, nonce, account: ctx.taker.account, chain: ctx.chain })
        const raw = await ctx.taker.signTransaction(prepared)
        tx = { requestId, step: 'expected-revert', action: 'cre-guard-rejected-swap', strategyHash: s.strategyHash,
          sender: ctx.taker.account.address, nonce, request, raw, hash: keccak256(raw) }
        store.put('txs', savedKey, tx) // Must precede broadcast; retry never signs again.
      }
      if (await ctx.pc.getTransactionCount({ address: tx.sender, blockTag: 'latest' }) > tx.nonce) throw new Error('Rejection nonce consumed without its receipt; inspect before resuming')
      await assertRejected()
      try { assert.equal(await ctx.pc.sendRawTransaction({ serializedTransaction: tx.raw }), tx.hash) }
      catch {
        try { receipt = await ctx.pc.getTransactionReceipt({ hash: tx.hash }) }
        catch { throw new Error(`Broadcast unresolved for ${tx.hash}; resume the same plan`) }
      }
      receipt ??= await waitMined(ctx, tx.hash)
    }
    assert.equal(receipt.transactionHash, tx!.hash)
    tx!.receipt = { status: receipt.status, blockHash: receipt.blockHash, blockNumber: String(receipt.blockNumber) }
    store.put('txs', savedKey, tx)
    rec.execution('cre-guard-rejected-swap', receipt, s.strategyHash)
    assert.equal(receipt.status, 'reverted')
    assert.equal(receipt.logs.length, 0)
    // Historical reads make verification repeatable even after cleanup docks
    // the strategy; a later wallet transfer must not invalidate old evidence.
    const balancesAt = async (blockNumber: bigint) => ({
      aqua: (await Promise.all(s.tokens.map(token => ctx.pc.readContract({ address: d.aqua, abi: aquaAbi,
        functionName: 'rawBalances', args: [s.params.maker, d.router, s.strategyHash, token], blockNumber })))).map(v => v[0].toString()),
      wallet: (await Promise.all(s.tokens.flatMap(address => [ctx.maker, ctx.taker].map(w => ctx.pc.readContract({ address,
        abi: erc20Abi, functionName: 'balanceOf', args: [w.account.address], blockNumber }))))).map(String),
    })
    const before = await balancesAt(receipt.blockNumber - 1n)
    const after = await balancesAt(receipt.blockNumber)
    assert.deepEqual(after, before)
    const proof = { chainId: 11155111, strategyHash: s.strategyHash, guard: d.guard.address, reason: 'DirectionDisabled',
      approvalTransactionHash: sender.get('approve')?.hash,
      transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), status: receipt.status, before, after }
    writeFileSync(values.out, json(proof) + '\n')
    console.log(json({ transactionHash: receipt.transactionHash, status: receipt.status, reason: 'DirectionDisabled', balancesUnchanged: true }))
  } finally { store.export(requestId); store.close() }
}
main().catch(e => { console.error(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : 'Rejection test failed'); process.exitCode = 1 })
