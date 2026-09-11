import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BaseError, decodeErrorResult, decodeEventLog, erc20Abi, keccak256, zeroAddress, zeroHash } from 'viem'
import { fromEnv, loadDeployment, readJson, RECORDS_DIR, type Ctx } from './config.ts'
import { compileGuarded, encodeGuardReport, guardArtifact, guardTestForwarderArtifact, buildTestReportTx, type GuardCaps, type GuardReport } from './guard.ts'
import { buildTx, quote, rawBalances, send, shipPreflight, takerSwap, waitMined } from './executor.ts'
import { takerTraits } from './compile.ts'
import { fixedParams } from './fixed-params.ts'
import { recorder, runStamp } from './records.ts'
import type { Deployment, Hex } from './types.ts'

/** Isolated test accounts only. Synthetic reports via our harness, not a CRE simulation or TEE attestation. */
export async function runGuardDemo(ctx: Ctx, d: Deployment, recordsDir = RECORDS_DIR) {
  if (![31337, 84532].includes(ctx.chain.id) || d.chainId !== ctx.chain.id || await ctx.pc.getChainId() !== ctx.chain.id) throw new Error('guard demo requires matching local or Base Sepolia chain')
  const tokens = [d.tokens.mWETH!, d.tokens.mUSDC!]
  // The demo owns its approvals and can therefore revoke them at the end.
  for (const token of tokens) for (const [wallet, spender] of [[ctx.maker, d.aqua], [ctx.taker, d.router]] as const) {
    const allowance = await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, spender] })
    if (allowance !== 0n) throw new Error('guard demo requires zero initial allowances and isolated demo accounts')
  }
  const rec = recorder({ dir: recordsDir, runId: `guard-demo-${runStamp()}`, chainId: ctx.chain.id, explorer: ctx.explorer })
  const mode = 'synthetic reports via project test harness; no CRE delivery or TEE attestation'
  rec.write({ kind: 'guard-demo-start', mode })
  const dep = async (artifact: typeof guardArtifact, args: unknown[]) => {
    const receipt = await waitMined(ctx, await ctx.maker.deployContract({ ...artifact, args }))
    rec.execution(`deploy:${artifact === guardArtifact ? 'AquaGuard' : 'GuardTestForwarder'}`, receipt)
    assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress)
    return receipt.contractAddress
  }
  const forwarder = await dep(guardTestForwarderArtifact, [])
  const guard = await dep(guardArtifact, [forwarder, d.router, zeroHash, zeroAddress, true])
  const caps: GuardCaps = { maxAmount0PerSwap: 10n ** 18n, maxAmount1PerSwap: 1_000_000_000n, maxPostBalance0: 3n * 10n ** 18n, maxPostBalance1: 7_000_000_000n }
  const p = await fixedParams(ctx, d, readJson('params/fixed.json'), { revision: 1, salt: BigInt(`0x${randomBytes(8).toString('hex')}`), feeBps: 0 })
  const s = compileGuarded(p, guard, caps)
  rec.write({ kind: 'guard-program', mode, forwarder, guard, params: s.params, order: s.order, strategy_hash: s.strategyHash, envelope: s.envelope })
  for (const [i, token] of s.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, i === 0 ? caps.maxPostBalance0 : caps.maxPostBalance1), 'maker-approve', rec)
  await shipPreflight(ctx, d, s)
  await send(ctx, ctx.maker, buildTx.ship(d, s), 'ship', rec, s.strategyHash)

  let nonce = 0n
  const reportHashes: Hex[] = []
  const publish = async (allowedDirections: number) => {
    const now = Number((await ctx.pc.getBlock()).timestamp)
    const report: GuardReport = { schemaVersion: 1, chainId: BigInt(ctx.chain.id), guard, router: d.router,
      maker: s.params.maker, strategyHash: s.strategyHash, token0: s.tokens[0]!, token1: s.tokens[1]!,
      nonce: ++nonce, validAfter: now, validUntil: now + 600, allowedDirections, ...caps }
    const receipt = await send(ctx, ctx.maker, buildTestReportTx(forwarder, guard, report), 'guard-report', rec, s.strategyHash)
    const digest = keccak256(encodeGuardReport(report))
    const stored = await ctx.pc.readContract({ address: guard, abi: guardArtifact.abi, functionName: 'getReport', args: [s.params.maker, s.strategyHash] }) as [GuardReport, Hex]
    assert.equal(stored[1], digest)
    const log = receipt.logs.find(l => l.address.toLowerCase() === guard.toLowerCase())!
    const event = decodeEventLog({ abi: guardArtifact.abi, data: log.data, topics: log.topics })
    assert.equal(event.eventName, 'ReportAccepted')
    rec.write({ kind: 'guard-report', mode, report, digest, tx_hash: receipt.transactionHash, event })
    reportHashes.push(receipt.transactionHash)
  }
  await publish(3)
  const swaps = [await takerSwap(ctx, d, s, s.tokens[1]!, 100_000_000n, 50, rec), await takerSwap(ctx, d, s, s.tokens[0]!, 10n ** 16n, 50, rec)]
  // Capture an allowed quote before disabling token1-in. The later tx must consult the new report.
  await quote(ctx, d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n)
  await publish(1)
  await send(ctx, ctx.taker, buildTx.approve(s.tokens[1]!, d.router, 100_000_000n), 'taker-approve-for-rejection', rec)
  const rejectedTx = buildTx.swap(d, s, s.tokens[1]!, s.tokens[0]!, 100_000_000n, takerTraits(0n))
  try {
    await ctx.pc.call({ ...rejectedTx, account: ctx.taker.account.address })
    throw new Error('expected DirectionDisabled before sending rejected demo swap')
  } catch (error) {
    if (!(error instanceof BaseError)) throw error
    const cause = error.walk(x => typeof (x as { data?: unknown }).data === 'string') as unknown as { data: Hex }
    assert.equal(decodeErrorResult({ abi: guardArtifact.abi, data: cause.data }).errorName, 'DirectionDisabled')
  }
  const balances = async () => ({
    aqua: (await rawBalances(ctx, d, s)).map(b => b.balance),
    wallet: await Promise.all(s.tokens.flatMap(token => [ctx.maker, ctx.taker].map(w => ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w.account.address] })))),
  })
  const before = await balances()
  // Explicitly bypass the usual preflight exactly once to produce an actual reverted testnet receipt.
  const rejected = await waitMined(ctx, await ctx.taker.sendTransaction({ ...rejectedTx, gas: 500_000n }))
  rec.execution('swap-guard-rejected', rejected, s.strategyHash)
  assert.equal(rejected.status, 'reverted'); assert.equal(rejected.logs.length, 0)
  const after = await balances(); assert.deepEqual(after, before)
  rec.write({ kind: 'guard-rejection-check', expected_error: 'DirectionDisabled', tx_hash: rejected.transactionHash, before, after })
  swaps.push(await takerSwap(ctx, d, s, s.tokens[0]!, 10n ** 16n, 50, rec))
  await publish(0)
  await send(ctx, ctx.maker, buildTx.dock(d, s), 'dock', rec, s.strategyHash)
  for (const token of s.tokens) {
    await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, 0n), 'maker-revoke', rec)
    await send(ctx, ctx.taker, buildTx.approve(token, d.router, 0n), 'taker-revoke', rec)
  }
  const state = await rawBalances(ctx, d, s)
  assert.ok(state.every(b => b.balance === 0n && b.tokensCount === 255))
  const summary = { mode, chainId: ctx.chain.id, aqua: d.aqua, router: d.router, forwarder, guard,
    strategyHash: s.strategyHash, reportHashes, swaps: swaps.map(swap => swap.txHash), rejectedSwap: rejected.transactionHash, finalState: state, file: rec.file }
  rec.write({ kind: 'cycle', status: 'completed', ...summary })
  writeFileSync(`${rec.file}.summary.json`, JSON.stringify(summary, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n')
  return summary
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { network: { type: 'string', default: 'local' } } })
  const ctx = fromEnv(values.network)
  console.log(JSON.stringify(await runGuardDemo(ctx, loadDeployment(ctx.chain.id)), (_, x) => typeof x === 'bigint' ? x.toString() : x, 2))
}
