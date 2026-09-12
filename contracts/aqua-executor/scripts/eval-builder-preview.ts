import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderSimulationFixture } from './builder-simulation-fixture.ts'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { previewSwapMath } from '../src/builder-preview.ts'
import { startBuilderFork } from '../src/builder-fork.ts'
import { aquaAbi, routerAbi } from '../src/abi.ts'
import { takerTraits } from '../src/compile.ts'
import { buildGuardReportTx } from '../src/guard.ts'

// Fresh unfunded addresses. The only writes are inside this owned Anvil child.
const fork = await startBuilderFork(profile, { rpcUrl: process.env.BUILDER_FORK_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', anvil: process.env.ANVIL })
const results: unknown[] = []
try {
  for (const kind of ['xyc', 'concentrated', 'pegged'] as const) for (const variant of ['balanced', 'unequal', 'reversed']) {
    const maker = privateKeyToAddress(generatePrivateKey()).toLowerCase() as Hex
    const draft = builderSimulationFixture(kind, maker)
    if (variant === 'unequal') draft.allocations = { baseAtomic: '7000000000000000', quoteAtomic: '30000000' }
    if (variant === 'reversed') {
      [draft.spec.baseToken, draft.spec.quoteToken] = [draft.spec.quoteToken, draft.spec.baseToken]
      draft.allocations = { baseAtomic: '25000000', quoteAtomic: '10000000000000000' }
      draft.spec.guardEnvelope = { maxAmountBasePerSwap: '12500000', maxAmountQuotePerSwap: '5000000000000000',
        maxPostBalanceBase: '50000000', maxPostBalanceQuote: '20000000000000000' }
      if (kind === 'concentrated') draft.spec.model = { kind, minPrice: '0.000357142857142858', maxPrice: '0.000454545454545454' }
      if (kind === 'pegged') draft.spec.model = { kind, referencePrice: '0.0004', amplification: '1' }
    }
    const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000)), tokens = compiled.tokens as [Hex, Hex]
    const order = { ...compiled.order, traits: BigInt(compiled.order.traits) }, caps = compiled.decoded.guardEnvelope
    const amounts = compiled.amounts.map(BigInt) as [bigint, bigint]
    const send = async (account: Hex, request: { to: Hex; data: Hex }) => fork.receipt(await fork.wallet(account).sendTransaction({ ...request, gas: 5_000_000n }))
    for (const [account, spender] of [[maker, profile.aqua], [fork.taker, profile.router]] as const) {
      await fork.fund(account, tokens.map((token, i) => ({ token, amount: String(amounts[i]! * 3n) })))
      for (const [i, token] of tokens.entries()) await send(account, { to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amounts[i]! * 3n] }) })
    }
    await send(maker, { to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [profile.router, compiled.strategy, tokens, amounts] }) })
    await fork.impersonate(profile.forwarder)
    await send(profile.forwarder, buildGuardReportTx(profile.guard, '0x', { schemaVersion: 2, chainId: BigInt(profile.chainId), guard: profile.guard,
      router: profile.router, maker, strategyHash: compiled.strategyHash, token0: tokens[0], token1: tokens[1], nonce: 1n,
      validAfter: Number((await fork.pc.getBlock()).timestamp), validUntil: 0, allowedDirections: 3,
      maxAmount0PerSwap: BigInt(caps.maxAmountBasePerSwap), maxAmount1PerSwap: BigInt(caps.maxAmountQuotePerSwap),
      maxPostBalance0: BigInt(caps.maxPostBalanceBase), maxPostBalance1: BigInt(caps.maxPostBalanceQuote) }))
    let balances: [bigint, bigint] = [...amounts]
    const trades: unknown[] = []
    for (const direction of [0, 1, 0] as const) {
      const amount = amounts[direction] / 100n, predicted = previewSwapMath(compiled.decoded, balances, direction, amount)
      const block = await fork.pc.getBlock()
      const q = await fork.pc.readContract({ address: profile.router, abi: routerAbi, functionName: 'quote', account: fork.taker,
        args: [order, tokens[direction], tokens[1 - direction]!, amount, takerTraits(0n)] })
      assert.equal(predicted.amountOut, q[1]); assert.ok(q[1] > 0n)
      const before = await Promise.all(tokens.map(token => fork.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [maker] })))
      const receipt = await send(fork.taker, { to: profile.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swap',
        args: [order, tokens[direction], tokens[1 - direction]!, amount, takerTraits(q[1])] }) })
      assert.equal((await fork.pc.getBlock({ blockHash: receipt.blockHash })).timestamp, block.timestamp)
      const next: [bigint, bigint] = [...balances]; next[direction] += amount; next[1 - direction] = balances[1 - direction]! - q[1]
      const after = await Promise.all(tokens.map(token => fork.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [maker] })))
      for (const i of [0, 1] as const) {
        assert.equal(after[i]! - before[i]!, next[i] - balances[i])
        assert.equal((await fork.pc.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [maker, profile.router, compiled.strategyHash, tokens[i]] }))[0], next[i])
      }
      trades.push({ tokenIn: direction === 0 ? 'base' : 'quote', amountInAtomic: String(amount), amountOutAtomic: String(q[1]), before: balances.map(String), after: next.map(String),
        quoteBlockHash: block.hash, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, mathematicalPreviewMatchesQuote: true, quoteMatchesSettlement: true })
      balances = next
    }
    results.push({ kind, variant, draft, trades })
    console.log(JSON.stringify({ kind, variant, trades: trades.length, passed: true }))
  }
  const paths = ['contracts/aqua-executor/src/builder-preview.ts', 'contracts/aqua-executor/src/builder-compile.ts',
    'contracts/aqua-executor/src/builder-fork.ts', 'contracts/aqua-executor/scripts/eval-builder-preview.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(new URL('../../../' + path, import.meta.url))).digest('hex')])))
  const evidence = { sourceHashes, ...fork.evidence, passed: true, publicChainWrites: 0, results }
  await mkdir(new URL('../../../.cache/builder/', import.meta.url), { recursive: true })
  await writeFile(new URL('../../../.cache/builder/preview-evaluation.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, strategies: results.length, settlements: 27, publicChainWrites: 0 }))
} finally { await fork.stop() }
