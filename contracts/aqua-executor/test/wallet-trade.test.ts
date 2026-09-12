import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem'
import { walletTakerTraits, verifiedTradeOrder } from '../../../shared/wallet-trade.mjs'
import { aquaAbi } from '../src/abi.ts'
import { takerTraits } from '../src/compile.ts'

test('browser settlement encoding matches the pinned SDK for threshold and uint40 deadline boundaries', () => {
  for (const minimum of [0n, 1n, 97003249236397n, (1n << 256n) - 1n]) {
    for (const deadline of [0n, 1789243368n, (1n << 40n) - 1n]) assert.equal(walletTakerTraits(minimum, deadline), takerTraits(minimum, deadline))
  }
  for (const [minimum, deadline] of [[-1n, 0n], [1n << 256n, 0n], [1n, -1n], [1n, 1n << 40n]]) assert.throws(() => walletTakerTraits(minimum, deadline))
})

test('wallet trade recovers the shipped order and rejects substituted receipts, versions, pairs and settlement settings', async () => {
  const maker = '0x1111111111111111111111111111111111111111', aqua = '0x2222222222222222222222222222222222222222', router = '0x3333333333333333333333333333333333333333'
  const tokens = ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'] as const
  const order = { maker, traits: 1n << 254n, data: '0x1234' } as const
  const tuple = [{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const
  const strategy = encodeAbiParameters(tuple, [order])
  const hash = `0x${'aa'.repeat(32)}` as const
  const tx = { from: maker, to: aqua, value: 0n, blockHash: hash, input: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [router, strategy, tokens, [1n, 1n]] }) }
  const receipt = { status: 'success', blockHash: hash }
  let chain = 11155111
  const client = { getChainId: async () => chain, getTransaction: async () => tx, getTransactionReceipt: async () => receipt } as unknown as Parameters<typeof verifiedTradeOrder>[0]
  const deployment = { aqua, router, tokens: { WETH: tokens[0], USDC: tokens[1] } }
  const selected = { maker, shipTransaction: hash, strategyHash: keccak256(strategy) }
  assert.deepEqual(await verifiedTradeOrder(client, deployment, selected), order)
  for (const [key, value] of [['from', aqua], ['to', router], ['value', 1n], ['blockHash', '0x1234']] as const) {
    const original = { ...tx }; Object.assign(tx, { [key]: value })
    await assert.rejects(verifiedTradeOrder(client, deployment, selected), /receipt/)
    Object.assign(tx, original)
  }
  chain = 1; await assert.rejects(verifiedTradeOrder(client, deployment, selected), /Sepolia/); chain = 11155111
  receipt.status = 'reverted'; await assert.rejects(verifiedTradeOrder(client, deployment, selected), /receipt/); receipt.status = 'success'
  await assert.rejects(verifiedTradeOrder(client, deployment, { ...selected, strategyHash: hash }), /differs/)
  await assert.rejects(verifiedTradeOrder(client, { ...deployment, tokens: { WETH: tokens[1], USDC: tokens[0] } }, selected), /differs/)
  const custom = encodeAbiParameters(tuple, [{ ...order, traits: (1n << 254n) | 1n }])
  tx.input = encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [router, custom, tokens, [1n, 1n]] })
  await assert.rejects(verifiedTradeOrder(client, deployment, { ...selected, strategyHash: keccak256(custom) }), /settlement/)
})

test('Guard verification recognizes decoded inactive-strategy errors, not incidental text', async () => {
  const { isInactiveStrategyError } = await import('../../../shared/wallet-trade.mjs');
  assert.equal(isInactiveStrategyError({ cause: { data: { errorName: 'StrategyNotActive' } } }), true);
  assert.equal(isInactiveStrategyError(new Error('StrategyNotActive')), false);
  assert.equal(isInactiveStrategyError({ data: { errorName: 'AmountLimitExceeded' } }), false);
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  assert.equal(isInactiveStrategyError(cycle), false);
});

test('wallet errors distinguish cancellation from ambiguous RPC sends without displaying calldata', async () => {
  const { walletErrorMessage } = await import('../../../shared/wallet-trade.mjs');
  assert.equal(walletErrorMessage({ cause: { code: 4001 } }), 'Wallet request cancelled.');
  const message = walletErrorMessage({ shortMessage: 'An unknown RPC error occurred.', message: 'Request Arguments: 0x095ea7b3 raw calldata', cause: { code: -32000 } });
  assert.match(message, /may already have been submitted/);
  assert.doesNotMatch(message, /095ea7b3|calldata|cancelled/);
  assert.match(walletErrorMessage({ name: 'WaitForTransactionReceiptTimeoutError' }), /existing transaction receipt/);
  assert.match(walletErrorMessage({ cause: { data: { errorName: 'StrategyNotActive' } } }), /not currently authorized/);
  assert.equal(walletErrorMessage(new Error('Request rejected by the service.')), 'Request rejected by the service.');
});
