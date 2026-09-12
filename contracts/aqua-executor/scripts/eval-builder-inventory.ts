import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { builderSimulationFixture } from './builder-simulation-fixture.ts'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { startBuilderFork } from '../src/builder-fork.ts'
import { readBuilderInventory } from '../src/builder-inventory.ts'
import { aquaAbi } from '../src/abi.ts'
import { buildGuardReportTx } from '../src/guard.ts'

const maker = privateKeyToAddress(generatePrivateKey()).toLowerCase() as Hex
const fork = await startBuilderFork(profile, { rpcUrl: process.env.BUILDER_INVENTORY_TEST_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', anvil: process.env.ANVIL })
try {
  const rpc = fork.pc.transport.url; assert.ok(typeof rpc === 'string')
  const draft = builderSimulationFixture('xyc', maker), second = { ...draft, id: 'second-shared-inventory', salt: '101' }
  const compiled = [draft, second].map(d => compileBuilderStrategy(d, profile, Math.floor(Date.now() / 1000)))
  const tokens = compiled[0]!.tokens as [Hex, Hex], amounts = compiled[0]!.amounts.map(BigInt)
  const send = async (account: Hex, request: { to: Hex; data: Hex }) => fork.receipt(await fork.wallet(account).sendTransaction({ ...request, gas: 5_000_000n }))
  await fork.fund(maker, tokens.map((token, i) => ({ token, amount: String(amounts[i]!) })))
  const capture = async (hashes = compiled.map(c => c.strategyHash)) => {
    await fork.dev('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]); await fork.dev('evm_mine', [])
    return readBuilderInventory(profile, maker, hashes, { rpcUrl: rpc, evidenceMode: 'fork-with-overrides' })
  }
  const initial = await capture()
  assert.ok(initial.strategies.every(s => s.state === 'unregistered-for-pair'))
  for (const c of compiled) await send(maker, { to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [profile.router, c.strategy, tokens, amounts] }) })
  const shipped = await capture()
  assert.equal(shipped.strategies.length, 2)
  assert.deepEqual(shipped.tokens, initial.tokens, 'ship has not deposited or added wallet tokens')
  assert.ok(shipped.strategies.every(s => s.state === 'shipped' && s.balances.every(b => b.inventoryAndAllowanceCapacityAtomic === '0')))
  for (const [i, token] of tokens.entries()) await send(maker, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [profile.aqua, amounts[i]!] }) })
  const approved = await capture([compiled[0]!.strategyHash, compiled[0]!.strategyHash, compiled[1]!.strategyHash])
  assert.equal(approved.strategies.length, 2, 'duplicate hashes are read once')
  for (const [i, token] of tokens.entries()) {
    const capacities = approved.strategies.map(s => BigInt(s.balances.find(b => b.token === token)!.inventoryAndAllowanceCapacityAtomic))
    assert.deepEqual(capacities, [amounts[i], amounts[i]])
    assert.equal(BigInt(approved.tokens.find(t => t.address === token)!.walletBalanceAtomic), amounts[i])
  }
  const c = compiled[0]!, caps = c.decoded.guardEnvelope
  await fork.impersonate(profile.forwarder)
  await send(profile.forwarder, buildGuardReportTx(profile.guard, '0x', { schemaVersion: 2, chainId: BigInt(profile.chainId), guard: profile.guard, router: profile.router,
    maker, strategyHash: c.strategyHash, token0: tokens[0], token1: tokens[1], nonce: 1n, validAfter: Number((await fork.pc.getBlock()).timestamp), validUntil: 0,
    allowedDirections: 3, maxAmount0PerSwap: BigInt(caps.maxAmountBasePerSwap), maxAmount1PerSwap: BigInt(caps.maxAmountQuotePerSwap),
    maxPostBalance0: BigInt(caps.maxPostBalanceBase), maxPostBalance1: BigInt(caps.maxPostBalanceQuote) }))
  const selected = await capture([])
  assert.equal(selected.strategies.length, 1); assert.equal(selected.strategies[0]!.source, 'guard-selection')
  assert.equal(selected.strategies[0]!.strategyHash, c.strategyHash); assert.equal(selected.strategies[0]!.selectedByGuard, true)
  await send(maker, { to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'dock', args: [profile.router, c.strategyHash, tokens] }) })
  const docked = await capture()
  assert.equal(docked.strategies[0]!.state, 'docked'); assert.equal(docked.strategies[0]!.selectedByGuard, true, 'a selected hash is not sufficient for settlement')
  assert.ok(docked.strategies[0]!.balances.every(b => b.inventoryAndAllowanceCapacityAtomic === '0'))
  assert.deepEqual(docked.tokens, approved.tokens, 'dock has not withdrawn or added wallet tokens')
  const paths = ['contracts/aqua-executor/src/builder-inventory.ts', 'contracts/aqua-executor/src/builder-token-proxy.ts', 'contracts/aqua-executor/scripts/eval-builder-inventory.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(new URL('../../../' + path, import.meta.url))).digest('hex')])))
  const evidence = { passed: true, publicChainWrites: 0, sourceHashes, fork: fork.evidence, drafts: [draft, second], initial, shipped, approved, selected, docked }
  await mkdir(new URL('../../../.cache/builder/', import.meta.url), { recursive: true })
  await writeFile(new URL('../../../.cache/builder/inventory-fork-evaluation.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode: 'fork-with-overrides', reads: 5, sharedStrategies: 2, publicChainWrites: 0 }))
} finally { await fork.stop() }
