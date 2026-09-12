import { TransactionReceiptNotFoundError, keccak256, type TransactionReceipt } from 'viem'
import type { Ctx, Wallet } from './config.ts'
import { revertReason, waitMined, type TxRequest } from './executor.ts'
import { ExecutionStore } from './execution-store.ts'
import type { Recorder } from './records.ts'
import type { Hex } from './types.ts'

export interface SavedTransaction {
  requestId: string
  step: string
  action: string
  strategyHash: Hex
  sender: Hex
  nonce: number
  request: TxRequest
  raw: Hex
  hash: Hex
  receipt?: { status: 'success' | 'reverted'; blockHash: Hex; blockNumber: string }
}
export class ExecutionRevertedError extends Error {}
export type TransactionHook = (event: { phase: 'prepared' | 'broadcast' | 'mined' | 'saved'; step: string; hash: Hex }) => void | Promise<void>
export const transactionKey = (requestId: string, step: string) => `${requestId}:${step}`

/** Persist signed bytes before broadcasting. Every recovery uses their original hash and nonce. */
export function durableSender(ctx: Ctx, store: ExecutionStore, requestId: string, rec: Recorder, hook?: TransactionHook, signal?: AbortSignal) {
  const get = (step: string) => store.get<SavedTransaction>('txs', transactionKey(requestId, step))
  const receipt = async (tx: SavedTransaction): Promise<TransactionReceipt | undefined> => {
    try {
      let r = await ctx.pc.getTransactionReceipt({ hash: tx.hash })
      if ((await ctx.pc.getBlockNumber({ cacheTime: 0 })) < r.blockNumber) r = await waitMined(ctx, tx.hash)
      if (r.transactionHash !== tx.hash) throw new Error(`receipt belongs to a replacement of ${tx.hash}; inspect before resuming`)
      if (tx.receipt && (r.blockHash !== tx.receipt.blockHash || r.status !== tx.receipt.status)) throw new Error(`receipt changed for ${tx.hash}; inspect the chain before resuming`)
      return r
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) {
        if (tx.receipt) throw new Error(`previously confirmed receipt is unavailable for ${tx.hash}; no new transaction was sent`)
        return undefined
      }
      throw e
    }
  }
  const audit = async () => {
    for (const tx of store.all<SavedTransaction>('txs').filter(t => t.requestId === requestId && t.receipt)) await receipt(tx)
  }
  const send = async (step: string, w: Wallet, action: string, strategyHash: Hex, prepare: () => Promise<TxRequest>) => {
    let tx = get(step)
    if (!tx) {
      signal?.throwIfAborted()
      const request = await prepare()
      try { await ctx.pc.call({ account: w.account.address, ...request }) }
      catch (e) { throw new Error(`${action} simulation failed: ${revertReason(e)}`) }
      const nonce = await ctx.pc.getTransactionCount({ address: w.account.address, blockTag: 'pending' })
      const prepared = await w.prepareTransactionRequest({ ...request, nonce, account: w.account, chain: ctx.chain })
      const raw = await w.signTransaction(prepared)
      tx = { requestId, step, action, strategyHash, sender: w.account.address, nonce, request, raw, hash: keccak256(raw) }
      signal?.throwIfAborted()
      store.put('txs', transactionKey(requestId, step), tx)
      rec.write({ kind: 'tx-prepared', step, action, strategy_hash: strategyHash, tx_hash: tx.hash, sender: tx.sender, nonce })
      await hook?.({ phase: 'prepared', step, hash: tx.hash })
    }
    if (tx.sender.toLowerCase() !== w.account.address.toLowerCase() || tx.action !== action || tx.strategyHash !== strategyHash || keccak256(tx.raw) !== tx.hash) throw new Error('saved transaction does not match this operation')
    let r = await receipt(tx)
    if (!r) {
      signal?.throwIfAborted()
      // A different transaction may have consumed this nonce outside the controller. Never allocate another nonce.
      const nonce = await ctx.pc.getTransactionCount({ address: tx.sender, blockTag: 'latest' })
      if (nonce > tx.nonce) throw new Error(`nonce ${tx.nonce} was consumed but receipt ${tx.hash} is unavailable; inspect before resuming`)
      try {
        const hash = await ctx.pc.sendRawTransaction({ serializedTransaction: tx.raw })
        if (hash !== tx.hash) throw new Error('RPC returned a different transaction hash')
      } catch {
        // Includes a lost response or "already known". Recheck this hash; do not build a replacement.
        r = await receipt(tx)
        if (!r) throw new Error(`broadcast outcome unresolved for ${tx.hash}; retry the same request to recover`)
      }
      await hook?.({ phase: 'broadcast', step, hash: tx.hash })
      r ??= await waitMined(ctx, tx.hash)
    }
    // viem's receipt waiter can follow a replacement transaction. Its receipt must never satisfy this intent.
    if (r.transactionHash !== tx.hash) throw new Error(`receipt belongs to a replacement of ${tx.hash}; inspect before resuming`)
    await hook?.({ phase: 'mined', step, hash: tx.hash })
    store.atomic(() => {
      tx!.receipt = { status: r!.status, blockHash: r!.blockHash, blockNumber: r!.blockNumber.toString() }
      store.put('txs', transactionKey(requestId, step), tx)
      rec.execution(action, r!, strategyHash)
    })
    await hook?.({ phase: 'saved', step, hash: tx.hash })
    if (r.status !== 'success') throw new ExecutionRevertedError(`${action} reverted on-chain: ${tx.hash}`)
    return r
  }
  return { get, audit, send }
}
