import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type PublicClient, type Hex } from 'viem'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { createWalletChain } from '../src/wallet-chain.ts'
import type { TransactionPlan } from '../src/transaction-plans.ts'

test('wallet RPC verifies exact calldata, replacement nonce, receipt events and canonical readback', async () => {
  const maker = '0x1111111111111111111111111111111111111111', token = profile.tokens[0]!.address, amount = 100n
  const plan = { maker, kind: 'registration', strategyHash: '0x' + '9'.repeat(64), tokens: profile.tokens.map(t => t.address), amounts: ['100','100'],
    transactions: [{ kind: 'erc20-approve', to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [profile.aqua, amount] }), value: '0x0', amountAtomic: '100' }] } as unknown as TransactionPlan
  const hash = '0x' + '1'.repeat(64) as Hex, replaced = '0x' + '2'.repeat(64) as Hex, blockHash = '0x' + '3'.repeat(64) as Hex
  let mode = 'correct', reads = 0
  const log = { address: token, data: encodeAbiParameters([{ type: 'uint256' }], [amount]), topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: maker, spender: profile.aqua } }) }
  const tx = () => ({ hash: replaced, from: mode === 'foreign' ? token : maker, nonce: 4, to: token, value: 0n,
    input: mode === 'replacement' ? '0x' : plan.transactions[0]!.data, blockHash, blockNumber: 100000n })
  const client = {
    getChainId: async () => mode === 'wrong-chain' ? 1 : profile.chainId,
    getBlock: async ({ blockNumber, includeTransactions }: { blockNumber?: bigint; includeTransactions?: boolean }) => ({ number: blockNumber ?? 100001n,
      hash: mode === 'reorg' && blockNumber === 100000n ? hash : blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)), transactions: includeTransactions ? [tx()] : [] }),
    getTransaction: async ({ hash: requested }: { hash: Hex }) => { if (requested === hash) throw Object.assign(new Error(), { name: 'TransactionNotFoundError' }); return tx() },
    getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => { reads++; return blockNumber >= 100000n ? 5 : 4 },
    getTransactionReceipt: async () => ({ blockNumber: 100000n, blockHash, status: mode === 'revert' ? 'reverted' : 'success', logs: mode === 'missing-log' ? [] : [log] }),
    readContract: async ({ functionName }: { functionName: string }) => functionName === 'router' ? profile.router : functionName === 'forwarder' ? profile.forwarder : 50n,
  } as unknown as PublicClient
  const chain = createWalletChain(profile, { client })
  const anchor = { nonce: '4', fromBlock: '1', transactionHash: hash }
  const result = await chain.reconcile(plan, 0, anchor)
  assert.equal(result?.state, 'confirmed'); assert.equal(result?.transactionHash, replaced); assert.equal(result?.evidence.allowance, '50')
  assert.ok(reads < 25, 'nonce search must not scan 100,000 blocks')
  mode = 'replacement'; assert.equal((await chain.reconcile(plan, 0, anchor))?.state, 'replaced')
  mode = 'revert'; assert.equal((await chain.reconcile(plan, 0, anchor))?.state, 'reverted')
  mode = 'missing-log'; await assert.rejects(chain.reconcile(plan, 0, anchor), /receipt-event-mismatch/)
  mode = 'foreign'; await assert.rejects(chain.reconcile(plan, 0, { ...anchor, transactionHash: replaced }), /transaction-mismatch/)
  mode = 'reorg'; assert.equal(await chain.reconcile(plan, 0, anchor), null)
  mode = 'wrong-chain'; await assert.rejects(chain.reconcile(plan, 0, anchor), /chain-mismatch/)
})
