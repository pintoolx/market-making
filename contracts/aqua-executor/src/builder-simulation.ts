import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { BaseError, decodeErrorResult, decodeEventLog, encodeFunctionData, erc20Abi, parseAbi, type Abi, type Hex } from 'viem'
import { canonical, digestJson, type DeploymentProfile, type StrategyDraft } from '@pintool/strategy-builder'
import { compileBuilderStrategy } from './builder-compile.ts'
import { startBuilderFork } from './builder-fork.ts'
import { aquaAbi, routerAbi } from './abi.ts'
import { takerTraits } from './compile.ts'
import { buildGuardReportTx, type GuardReport } from './guard.ts'
import { readJson } from './config.ts'

const S = createRequire(import.meta.url)('@1inch/swap-vm-sdk')
const guardAbi = (readJson('artifacts/AquaGuardV2.json') as { abi: Abi }).abi
type Compilation = ReturnType<typeof compileBuilderStrategy>
type CaseResult = { name: string; passed: boolean | null; error?: string; details?: unknown }

/** Only a newly owned Anvil fork receives writes. The input must reproduce the exact saved compilation. */
export async function simulateBuilderLifecycle(draft: StrategyDraft, compilation: Compilation, profile: DeploymentProfile,
  options: Parameters<typeof startBuilderFork>[1]) {
  if (canonical(compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))) !== canonical(compilation)) throw new Error('simulation-artifact-mismatch')
  const fork = await startBuilderFork(profile, options), { pc } = fork
  const maker = compilation.order.maker, taker = fork.taker, tokens = compilation.tokens as [Hex, Hex]
  const amounts = compilation.amounts.map(BigInt), caps = compilation.decoded.guardEnvelope
  const limits = [BigInt(caps.maxAmountBasePerSwap), BigInt(caps.maxAmountQuotePerSwap)]
  const order = { ...compilation.order, traits: BigInt(compilation.order.traits) }
  const cases: CaseResult[] = [], swaps: unknown[] = []
  let phase = 'setup', nonce = 1n
  const errorName = (error: unknown) => {
    if (error instanceof BaseError) {
      const item = error.walk(e => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex }
      if (item?.data) { try { return decodeErrorResult({ abi: [...guardAbi, ...routerAbi], data: item.data }).errorName } catch { return 'unknown-contract-revert' } }
      return 'fork-rpc-unavailable'
    }
    if (error instanceof assert.AssertionError) return 'simulation-expectation-failed'
    return error instanceof Error && /^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : 'simulation-unavailable'
  }
  const tx = async (from: Hex, request: { to: Hex; data: Hex }, expected: 'success' | 'reverted' = 'success') => {
    const hash = await fork.wallet(from).sendTransaction({ ...request, gas: 5_000_000n })
    const receipt = await fork.waitForReceipt(hash)
    assert.equal(receipt.status, expected)
    return receipt
  }
  const state = async () => ({
    maker: await Promise.all(tokens.map(token => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [maker] }).then(String))),
    taker: await Promise.all(tokens.map(token => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [taker] }).then(String))),
    aqua: await Promise.all(tokens.map(async token => {
      const [balance, count] = await pc.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [maker, profile.router, compilation.strategyHash, token] })
      return { balance: String(balance), count }
    })),
  })
  const quote = async (direction: 0 | 1, amount: bigint, traits = takerTraits(0n)) => {
    const [amountIn, amountOut, orderHash] = await pc.readContract({ address: profile.router, abi: routerAbi, functionName: 'quote',
      args: [order, tokens[direction], tokens[1 - direction]!, amount, traits], account: taker })
    assert.equal(orderHash, compilation.orderHash)
    return { amountIn, amountOut }
  }
  const swapRequest = (direction: 0 | 1, amount: bigint, traits = takerTraits(0n)) => ({ to: profile.router,
    data: encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [order, tokens[direction], tokens[1 - direction]!, amount, traits] }) })
  const tradeAmount = (direction: 0 | 1) => {
    const capPart = limits[direction]! / 10n, inventoryPart = amounts[direction]! / 100n
    const value = capPart < inventoryPart ? capPart : inventoryPart
    return value > 0n ? value : 1n
  }
  const report = async (patch: Partial<GuardReport> = {}) => {
    const r: GuardReport = { schemaVersion: 2, chainId: BigInt(profile.chainId), guard: profile.guard, router: profile.router, maker,
      strategyHash: compilation.strategyHash, token0: tokens[0], token1: tokens[1], nonce: nonce++, validAfter: Number((await pc.getBlock()).timestamp), validUntil: 0,
      allowedDirections: 3, maxAmount0PerSwap: limits[0]!, maxAmount1PerSwap: limits[1]!, maxPostBalance0: BigInt(caps.maxPostBalanceBase),
      maxPostBalance1: BigInt(caps.maxPostBalanceQuote), ...patch }
    await tx(profile.forwarder, buildGuardReportTx(profile.guard, '0x', r))
    return r
  }
  const authorization = async () => ({
    report: await pc.readContract({ address: profile.guard, abi: guardAbi, functionName: 'getReport', args: [maker, compilation.strategyHash] }),
    active: await pc.readContract({ address: profile.guard, abi: guardAbi, functionName: 'activeStrategyHash', args: [maker] }),
  })
  const rejected = async (request: { to: Hex; data: Hex }, from: Hex, expected?: string) => {
    let reason: string | undefined
    try { await pc.call({ ...request, account: from }) } catch (error) { reason = errorName(error) }
    assert.ok(reason, 'call must revert before sending the rejection fixture')
    assert.ok(!reason.includes('unavailable'), 'an RPC failure is not a contract rejection')
    if (expected) assert.equal(reason, expected)
    const before = await state(), guardBefore = await authorization(), receipt = await tx(from, request, 'reverted'), after = await state()
    assert.deepEqual(after, before, 'rejected transaction must preserve ERC20 and virtual inventory')
    assert.deepEqual(await authorization(), guardBefore)
    return { revert: reason, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, tokenBalancesUnchanged: true,
      authorizationUnchanged: true, nativeGasExcluded: true }
  }
  const isolated = async (name: string, work: () => Promise<unknown>) => {
    phase = name
    const snapshot = await fork.dev('evm_snapshot', [])
    try { cases.push({ name, passed: true, details: await work() }) }
    finally { await fork.dev('evm_revert', [snapshot]) }
  }
  const successfulSwap = async (direction: 0 | 1, amount = tradeAmount(direction)) => {
    const context = await pc.getBlock(), q = await quote(direction, amount), before = await state(), guardBefore = await authorization()
    assert.equal(q.amountIn, amount); assert.ok(q.amountOut > 0n)
    const receipt = await tx(taker, swapRequest(direction, amount, takerTraits(q.amountOut)))
    assert.equal((await pc.getBlock({ blockHash: receipt.blockHash })).timestamp, context.timestamp)
    const event = receipt.logs.filter(l => l.address.toLowerCase() === profile.router).flatMap(log => {
      try { const e = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics }); return e.eventName === 'Swapped' ? [e] : [] } catch { return [] }
    }).find(e => e.eventName === 'Swapped')
    assert.ok(event && event.eventName === 'Swapped'); assert.equal(event.args.amountIn, amount); assert.equal(event.args.amountOut, q.amountOut)
    const after = await state(), out = 1 - direction
    assert.deepEqual(await authorization(), guardBefore)
    for (const [name, sign] of [['maker', 1n], ['taker', -1n]] as const) {
      assert.equal(BigInt(after[name][direction]!) - BigInt(before[name][direction]!), amount * sign)
      assert.equal(BigInt(after[name][out]!) - BigInt(before[name][out]!), -q.amountOut * sign)
    }
    assert.equal(BigInt(after.aqua[direction]!.balance) - BigInt(before.aqua[direction]!.balance), amount)
    assert.equal(BigInt(after.aqua[out]!.balance) - BigInt(before.aqua[out]!.balance), -q.amountOut)
    const result = { tokenIn: tokens[direction], tokenOut: tokens[out], amountIn: String(amount), amountOut: String(q.amountOut),
      transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, case: phase,
      contextTimestamp: String(context.timestamp), quoteBlockHash: context.hash, quoteMatchesSettlement: true, inventoryMatchesTransfers: true }
    swaps.push(result); return result
  }
  try {
    phase = 'read-initial-inventory'
    const original = await state()
    if (original.aqua.some(b => b.count !== 0)) throw new Error('simulation-requires-unregistered-strategy')
    phase = 'read-initial-report'
    const stored = await pc.readContract({ address: profile.guard, abi: guardAbi, functionName: 'getReport', args: [maker, compilation.strategyHash] }) as [GuardReport, Hex]
    if (BigInt(stored[0].nonce) !== 0n) throw new Error('simulation-requires-unused-report')
    const fund = (factor: bigint) => tokens.map((token, i) => ({ token, amount: String(amounts[i]! + limits[i]! * factor) }))
    phase = 'fund-maker'
    await fork.fund(maker, fund(4n))
    phase = 'fund-taker'
    await fork.fund(taker, fund(4n)); await fork.impersonate(profile.forwarder)
    phase = 'approve-local-inventory'
    for (const [i, token] of tokens.entries()) {
      for (const [account, spender] of [[maker, profile.aqua], [taker, profile.router]] as const) {
        await tx(account, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amounts[i]! + limits[i]! * 4n] }) })
      }
    }
    phase = 'registration'
    await tx(maker, { to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [profile.router, compilation.strategy, tokens, amounts] }) })
    assert.deepEqual((await state()).aqua, amounts.map(amount => ({ balance: String(amount), count: 2 })))
    cases.push({ name: 'registration', passed: true })
    await isolated('missing-report', () => rejected(swapRequest(0, tradeAmount(0)), taker, 'MissingReport'))
    await report()
    await isolated('bidirectional-and-sequential-settlement', async () => {
      await successfulSwap(0); await successfulSwap(1); await successfulSwap(0)
      return { successfulSwaps: 3 }
    })
    for (const direction of [0, 1] as const) await isolated(`amount-cap-${direction}`, () => rejected(swapRequest(direction, limits[direction]! + 1n), taker, 'AmountLimitExceeded'))
    await isolated('direction-disabled', async () => { await report({ allowedDirections: 2 }); return rejected(swapRequest(0, tradeAmount(0)), taker, 'DirectionDisabled') })
    await isolated('inventory-cap', async () => { await report({ maxPostBalance0: amounts[0]! }); return rejected(swapRequest(0, tradeAmount(0)), taker, 'InventoryLimitExceeded') })
    for (const direction of [0, 1] as const) await isolated(`exact-cap-boundaries-${direction}`, async () => {
      const amount = tradeAmount(direction), q = await quote(direction, amount)
      if (amount <= 1n || q.amountOut <= 1n) throw new Error('boundary-needs-atomic-margin')
      const tight = { maxAmount0PerSwap: direction === 0 ? amount : q.amountOut, maxAmount1PerSwap: direction === 1 ? amount : q.amountOut,
        maxPostBalance0: amounts[0]! + (direction === 0 ? amount : -q.amountOut),
        maxPostBalance1: amounts[1]! + (direction === 1 ? amount : -q.amountOut) }
      const rejections = []
      for (const key of Object.keys(tight) as (keyof typeof tight)[]) {
        await report({ ...tight, [key]: tight[key] - 1n })
        rejections.push(await rejected(swapRequest(direction, amount), taker, key.startsWith('maxAmount') ? 'AmountLimitExceeded' : 'InventoryLimitExceeded'))
      }
      await report(tight)
      return { oneAtomicUnitOver: rejections, exactlyAtAllFourCaps: await successfulSwap(direction) }
    })
    for (const direction of [0, 1] as const) await isolated(`exact-out-rejected-${direction}`, async () => {
      const q = await quote(direction, tradeAmount(direction))
      return rejected(swapRequest(direction, q.amountOut, S.TakerTraits.new({ exactIn: false, useTransferFromAndAquaPush: true }).encode().toString()), taker, 'UnsupportedSwap')
    })
    await isolated('report-domain-and-source', async () => {
      const baseline = await report(), rejectedReports = []
      for (const patch of [{ chainId: 1n }, { guard: maker }, { router: maker }])
        rejectedReports.push(await rejected(buildGuardReportTx(profile.guard, '0x', { ...baseline, nonce: nonce++, ...patch }), profile.forwarder, 'InvalidReportDomain'))
      rejectedReports.push(await rejected(buildGuardReportTx(profile.guard, '0x', { ...baseline, nonce: nonce++ }), taker, 'UnauthorizedForwarder'))
      return rejectedReports
    })
    await isolated('report-token-pair', async () => {
      await report({ token0: tokens[1], token1: tokens[0] })
      return rejected(swapRequest(0, tradeAmount(0)), taker, 'TokenPairMismatch')
    })
    await isolated('report-idempotency-and-replay', async () => {
      const baseline = await report(), before = await authorization()
      const repeated = await tx(profile.forwarder, buildGuardReportTx(profile.guard, '0x', baseline))
      assert.equal(repeated.logs.length, 0); assert.deepEqual(await authorization(), before)
      return { identicalReportEvents: 0, conflict: await rejected(buildGuardReportTx(profile.guard, '0x', { ...baseline, allowedDirections: 2 }), profile.forwarder, 'ReportReplay') }
    })
    await isolated('active-strategy-switch', async () => {
      const secondHash = digestJson({ alternate: compilation.strategyHash })
      await report({ strategyHash: secondHash })
      await rejected(swapRequest(0, tradeAmount(0)), taker, 'StrategyNotActive')
      await report({ allowedDirections: 0 })
      assert.equal((await authorization()).active, secondHash, 'pausing inactive A cannot pause active B')
      await report(); return successfulSwap(0)
    })
    if (compilation.decoded.deadline >= Number((await pc.getBlock()).timestamp) + 600) await isolated('schema-one-expiry', async () => {
      const now = Number((await pc.getBlock()).timestamp)
      await report({ schemaVersion: 1, validUntil: now + 600 })
      await fork.dev('evm_setNextBlockTimestamp', [now + 599]); await fork.dev('evm_mine', [])
      await successfulSwap(0)
      await fork.dev('evm_setNextBlockTimestamp', [now + 600]); await fork.dev('evm_mine', [])
      return rejected(swapRequest(0, tradeAmount(0)), taker, 'ReportNotCurrent')
    })
    else cases.push({ name: 'schema-one-expiry', passed: null, details: { reason: 'program-deadline-within-ten-minutes' } })
    for (const direction of [0, 1] as const) await isolated(`maker-wallet-empty-${direction}`, async () => {
      const token = tokens[1 - direction]!, balance = BigInt((await state()).maker[1 - direction]!)
      await tx(maker, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [taker, balance] }) })
      assert.ok((await quote(direction, tradeAmount(direction))).amountOut > 0n, 'virtual inventory can quote while the wallet cannot settle')
      return rejected(swapRequest(direction, tradeAmount(direction)), taker, 'SafeTransferFromFailed')
    })
    for (const direction of [0, 1] as const) await isolated(`virtual-output-exhausted-${direction}`, async () => {
      // Stress-state override, not a claim that this router exposes an arbitrary public pull path.
      // IAqua.pull from aqua@9c5c42e; only the local fork impersonates the application.
      await fork.impersonate(profile.router)
      const token = tokens[1 - direction]!, balance = BigInt((await state()).aqua[1 - direction]!.balance)
      await tx(profile.router, { to: profile.aqua, data: encodeFunctionData({ abi: parseAbi(['function pull(address maker,bytes32 strategyHash,address token,uint256 amount,address to)']),
        functionName: 'pull', args: [maker, compilation.strategyHash, token, balance, taker] }) })
      assert.equal((await state()).aqua[1 - direction]!.balance, '0')
      return { override: 'synthetic-router-pull-to-exhaust-virtual-inventory', rejection: await rejected(swapRequest(direction, tradeAmount(direction)), taker) }
    })
    const block = await pc.getBlock()
    if (BigInt(compilation.decoded.deadline) > block.timestamp + 3602n) await isolated('standing-after-one-hour', async () => {
      await fork.dev('evm_setNextBlockTimestamp', [Number(block.timestamp + 3601n)]); await fork.dev('evm_mine', [])
      return successfulSwap(0)
    })
    else cases.push({ name: 'standing-after-one-hour', passed: null, details: { reason: 'program-deadline-within-one-hour' } })
    await isolated('deadline-before-and-at', async () => {
      await fork.dev('evm_setNextBlockTimestamp', [compilation.decoded.deadline - 1]); await fork.dev('evm_mine', [])
      await successfulSwap(0)
      await fork.dev('evm_setNextBlockTimestamp', [compilation.decoded.deadline]); await fork.dev('evm_mine', [])
      return successfulSwap(1)
    })
    await isolated('deadline-rejected', async () => {
      await fork.dev('evm_setNextBlockTimestamp', [compilation.decoded.deadline + 1]); await fork.dev('evm_mine', [])
      return rejected(swapRequest(0, tradeAmount(0)), taker, 'DeadlineReached')
    })
    await isolated('maker-revoke-and-unrevoke', async () => {
      const revoke = (value: boolean) => tx(maker, { to: profile.guard, data: encodeFunctionData({ abi: guardAbi, functionName: 'setStrategyRevoked', args: [compilation.strategyHash, value] }) })
      await revoke(true); await rejected(swapRequest(0, tradeAmount(0)), taker, 'StrategyNotActive')
      await rejected(buildGuardReportTx(profile.guard, '0x', { ...await report({ allowedDirections: 0 }), nonce: nonce++, allowedDirections: 3 }), profile.forwarder, 'StrategyRevoked')
      await revoke(false); await rejected(swapRequest(0, tradeAmount(0)), taker, 'StrategyNotActive')
      await report(); return successfulSwap(0)
    })
    await isolated('dock-rejected', async () => {
      await tx(maker, { to: profile.aqua, data: encodeFunctionData({ abi: aquaAbi, functionName: 'dock', args: [profile.router, compilation.strategyHash, tokens] }) })
      assert.ok((await state()).aqua.every(b => b.count === 255 && b.balance === '0'))
      return rejected(swapRequest(0, tradeAmount(0)), taker)
    })
  } catch (error) {
    const types: string[] = []
    let cause: unknown = error
    for (let i = 0; cause instanceof Error && i < 10; i++, cause = cause.cause) types.push(cause.constructor.name)
    cases.push({ name: phase, passed: false, error: errorName(error), details: { types,
      ...(error instanceof assert.AssertionError ? { actual: String(error.actual), expected: String(error.expected) } : {}) } })
  }
  finally { await fork.stop() }
  return { schemaVersion: 1, engineVersion: 'builder-lifecycle-v1', ...fork.evidence, draftId: draft.id, revision: draft.revision, artifactDigest: digestJson(compilation),
    passed: cases.length > 0 && cases.every(c => c.passed !== false), coverageComplete: cases.length > 0 && cases.every(c => c.passed === true),
    cases, swaps, simulatedTransactionsOnly: true, registrationReady: false as const }
}
