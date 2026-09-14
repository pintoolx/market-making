import { createPublicClient, decodeEventLog, erc20Abi, http, parseAbi, type Hex, type PublicClient } from 'viem'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import type { TransactionPlan } from './transaction-plans.ts'
import { ServiceError } from './errors.ts'

const aquaAbi = parseAbi([
  'function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns (uint248 balance,uint8 tokensCount)',
  'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
  'event Docked(address maker,address app,bytes32 strategyHash)',
])
const guardAbi = parseAbi([
  'function router() view returns (address)', 'function forwarder() view returns (address)',
  'function activeStrategyHash(address maker) view returns (bytes32)',
  'function strategyRevoked(address maker,bytes32 strategyHash) view returns (bool)',
  'event StrategyRevocationChanged(address indexed maker,bytes32 indexed strategyHash,bool revoked)',
])
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
export type WalletRequest = { chainId: number; from: Hex; to: Hex; data: Hex; value: '0x0'; nonce: string; gas: string; expiresAt: string }
export type WalletAnchor = { nonce: string; fromBlock: string; transactionHash: Hex | null }
export type WalletOutcome = { state: 'pending' | 'confirmed' | 'reverted' | 'replaced'; transactionHash: Hex; evidence: Record<string, unknown> }
export interface WalletChain {
  preflight(plan: TransactionPlan, step: number): Promise<{ request: WalletRequest; fromBlock: string; observedAt: string; blockHash: Hex }>
  reconcile(plan: TransactionPlan, step: number, anchor: WalletAnchor): Promise<WalletOutcome | null>
  unused(plan: TransactionPlan, nonce: string): Promise<boolean>
}

/** Public RPC only. This module has no signing or sendRawTransaction capability. */
export function createWalletChain(profile: DeploymentProfile, options: { rpcUrl?: string; client?: PublicClient; confirmations?: number }): WalletChain {
  const client = options.client ?? createPublicClient({ transport: http(options.rpcUrl, { timeout: 15000, retryCount: 1 }) })
  const evidenceMode = profile.chainId === 31337 ? 'local-upstream' : 'live-read'
  const confirmations = options.confirmations ?? 2
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 64) throw new Error('invalid-wallet-confirmations')
  const guard = (functionName: 'router' | 'forwarder' | 'activeStrategyHash' | 'strategyRevoked', args: readonly unknown[], blockNumber: bigint) =>
    client.readContract({ address: profile.guard, abi: guardAbi, functionName, args, blockNumber } as Parameters<typeof client.readContract>[0])
  async function head() {
    if (await client.getChainId() !== profile.chainId) throw new ServiceError('wallet-chain-mismatch', 503)
    const block = await client.getBlock({ blockTag: 'latest' })
    if (block.number === null || !block.hash || Number(block.timestamp) < Date.now() / 1000 - 120 || Number(block.timestamp) > Date.now() / 1000 + 30)
      throw new ServiceError('wallet-chain-stale', 503)
    const [router, forwarder] = await Promise.all([guard('router', [], block.number), guard('forwarder', [], block.number)])
    if (!same(router, profile.router) || !same(forwarder, profile.forwarder)) throw new ServiceError('wallet-profile-mismatch', 503)
    return block
  }
  const balances = (plan: TransactionPlan, blockNumber: bigint) => Promise.all(plan.tokens.map(token =>
    client.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [plan.maker, profile.router, plan.strategyHash, token], blockNumber })))
  return {
    async preflight(plan, step) {
      const tx = plan.transactions[step]
      if (!tx) throw new ServiceError('wallet-step-invalid')
      const block = await head(), blockNumber = block.number!
      const [latestNonce, pendingNonce, raw] = await Promise.all([
        client.getTransactionCount({ address: plan.maker, blockNumber }), client.getTransactionCount({ address: plan.maker, blockTag: 'pending' }), balances(plan, blockNumber),
      ])
      if (!Number.isSafeInteger(latestNonce) || !Number.isSafeInteger(pendingNonce)) throw new ServiceError('wallet-nonce-range', 503)
      if (latestNonce !== pendingNonce) throw new ServiceError('wallet-external-transaction-pending', 409)
      if (plan.kind === 'registration') {
        if (raw.some(item => Number(item[1]) !== 0)) throw new ServiceError('wallet-strategy-already-registered', 409)
        if (await guard('strategyRevoked', [plan.maker, plan.strategyHash], blockNumber)) throw new ServiceError('wallet-strategy-revoked', 409)
        for (const [i, token] of plan.tokens.entries()) {
          const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [plan.maker], blockNumber })
          if (balance < BigInt(plan.amounts[i]!)) throw new ServiceError('wallet-insufficient-token-balance', 409)
          if (tx.kind === 'aqua-ship') {
            const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [plan.maker, profile.aqua], blockNumber })
            if (allowance < BigInt(plan.amounts[i]!)) throw new ServiceError('wallet-insufficient-allowance', 409)
          }
        }
      }
      if (tx.kind === 'aqua-dock' && raw.some(item => Number(item[1]) !== 2)) throw new ServiceError('wallet-strategy-not-registered', 409)
      await client.call({ account: plan.maker, to: tx.to, data: tx.data, value: 0n, blockNumber })
      const estimate = await client.estimateGas({ account: plan.maker, to: tx.to, data: tx.data, value: 0n })
      const gas = estimate * 12n / 10n + 1000n
      const [gasPrice, balance] = await Promise.all([client.getGasPrice(), client.getBalance({ address: plan.maker, blockNumber })])
      if (balance < gas * gasPrice) throw new ServiceError('wallet-insufficient-gas', 409)
      if (!same((await client.getBlock({ blockNumber })).hash, block.hash)) throw new ServiceError('wallet-chain-reorg', 503)
      return { request: { chainId: profile.chainId, from: plan.maker, to: tx.to, data: tx.data, value: '0x0', nonce: String(latestNonce), gas: String(gas),
        expiresAt: new Date(Date.now() + 30000).toISOString() }, fromBlock: String(blockNumber), observedAt: new Date().toISOString(), blockHash: block.hash! }
    },
    async unused(plan, nonce) {
      await head()
      const counts = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: plan.maker, blockTag: blockTag as 'latest' | 'pending' })))
      return counts.every(n => BigInt(n) === BigInt(nonce))
    },
    async reconcile(plan, step, anchor) {
      const latest = await head(), end = latest.number! - BigInt(confirmations - 1)
      let tx: Awaited<ReturnType<typeof client.getTransaction>> | undefined
      if (anchor.transactionHash) {
        try { tx = await client.getTransaction({ hash: anchor.transactionHash }) }
        catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error }
        if (tx && (!same(tx.from, plan.maker) || BigInt(tx.nonce) !== BigInt(anchor.nonce))) throw new ServiceError('wallet-transaction-mismatch', 409)
      }
      // Repriced/replaced transactions and lost browser responses are recovered by
      // Maker + nonce from canonical blocks. Missing evidence never releases a nonce.
      if (!tx || tx.blockNumber === null) {
        const count = await client.getTransactionCount({ address: plan.maker, blockNumber: end })
        if (BigInt(count) <= BigInt(anchor.nonce)) return tx ? { state: 'pending', transactionHash: tx.hash, evidence: { mode: evidenceMode } } : null
        // Account nonce is monotonic within the canonical chain. Binary search
        // finds the consumption block without scanning days of transactions.
        let low = BigInt(anchor.fromBlock), high = end, reads = 0
        while (low < high) {
          if (++reads > 64) throw new ServiceError('wallet-recovery-hash-required', 409)
          const middle = (low + high) / 2n, consumed = await client.getTransactionCount({ address: plan.maker, blockNumber: middle })
          if (BigInt(consumed) > BigInt(anchor.nonce)) high = middle
          else low = middle + 1n
        }
        const block = await client.getBlock({ blockNumber: low, includeTransactions: true })
        tx = block.transactions.find(t => same(t.from, plan.maker) && BigInt(t.nonce) === BigInt(anchor.nonce))
      }
      if (!tx || tx.blockNumber === null || tx.blockNumber > end) return tx ? { state: 'pending', transactionHash: tx.hash, evidence: { mode: evidenceMode } } : null
      const receipt = await client.getTransactionReceipt({ hash: tx.hash })
      if (!same(receipt.blockHash, tx.blockHash) || !same((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)) return null
      const expected = plan.transactions[step]!, matches = same(tx.to, expected.to) && same(tx.input, expected.data) && tx.value === 0n
      const evidence: Record<string, unknown> = { mode: evidenceMode, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, confirmations,
        nonce: anchor.nonce, matchesPlan: matches, replacedHash: anchor.transactionHash && !same(anchor.transactionHash, tx.hash) ? anchor.transactionHash : null }
      if (!matches) return { state: 'replaced', transactionHash: tx.hash, evidence }
      if (receipt.status !== 'success') return { state: 'reverted', transactionHash: tx.hash, evidence }
      const abi = expected.kind === 'erc20-approve' ? erc20Abi : expected.kind.startsWith('guard-') ? guardAbi : aquaAbi
      const exactEvent = receipt.logs.some(log => {
        if (!same(log.address, expected.to)) return false
        try {
          const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }), args = event.args as Record<string, unknown>
          if (expected.kind === 'erc20-approve') return event.eventName === 'Approval' && same(args.owner, plan.maker) && same(args.spender, profile.aqua) && String(args.value) === expected.amountAtomic
          if (expected.kind.startsWith('guard-')) return event.eventName === 'StrategyRevocationChanged' && same(args.maker, plan.maker) && same(args.strategyHash, plan.strategyHash) && args.revoked === (expected.kind === 'guard-revoke')
          return event.eventName === (expected.kind === 'aqua-ship' ? 'Shipped' : 'Docked') && same(args.maker, plan.maker) && same(args.app, profile.router) && same(args.strategyHash, plan.strategyHash)
        } catch { return false }
      })
      if (!exactEvent) throw new ServiceError('wallet-receipt-event-mismatch', 503)
      if (expected.kind.startsWith('aqua-')) {
        const raw = await balances(plan, receipt.blockNumber), count = expected.kind === 'aqua-ship' ? 2 : 255
        if (raw.some(item => Number(item[1]) !== count)) throw new ServiceError('wallet-readback-mismatch', 503)
        evidence.balances = raw.map((item, i) => ({ token: plan.tokens[i], balance: String(item[0]), tokensCount: Number(item[1]) }))
      } else if (expected.kind.startsWith('guard-')) {
        if (await guard('strategyRevoked', [plan.maker, plan.strategyHash], receipt.blockNumber) !== (expected.kind === 'guard-revoke')) throw new ServiceError('wallet-readback-mismatch', 503)
      } else {
        // Later fills can consume approval in the same block. The exact Approval
        // event proves the change; record actual readback without assuming no fills.
        evidence.allowance = String(await client.readContract({ address: expected.to, abi: erc20Abi, functionName: 'allowance', args: [plan.maker, profile.aqua], blockNumber: receipt.blockNumber }))
      }
      if (!same((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)) return null
      return { state: 'confirmed', transactionHash: tx.hash, evidence }
    },
  }
}
