import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodeFunctionData, zeroHash, zeroAddress, type Abi } from 'viem'
import { foundry } from 'viem/chains'
import { ANVIL_KEYS, connect, readJson } from '../../src/config.ts'
import { deploy } from '../../src/deploy.ts'
import { buildTx, send, waitMined } from '../../src/executor.ts'
import { recorder } from '../../src/records.ts'
import { guardArtifact, guardTestForwarderArtifact, buildTestReportTx, type GuardCaps, type GuardedCompiled, type GuardReport } from '../../src/guard.ts'
import type { AquaStrategyParams, Hex } from '../../src/types.ts'

export async function lpFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-lp-'))
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(r => server.close(() => r()))
  const rpc = `http://127.0.0.1:${port}`
  const anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  let failed: Error | undefined; anvil.on('error', e => { failed = e })
  const ctx = connect(foundry, rpc, ANVIL_KEYS[0], ANVIL_KEYS[1])
  try {
    for (let i = 0; ; i++) {
      if (failed) throw failed
      try { await ctx.pc.getChainId(); break } catch (e) { if (i > 30) throw e; await sleep(100) }
    }
    const rec = recorder({ dir, runId: 'lp', chainId: 31337, explorer: null })
    const d = await deploy(ctx, rec)
    const dep = async (artifact: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
      const r = await waitMined(ctx, await ctx.maker.deployContract({ ...artifact, args }))
      assert.equal(r.status, 'success'); assert.ok(r.contractAddress); return r.contractAddress
    }
    const tokenArtifact = readJson('artifacts/MockERC20.json') as { abi: Abi; bytecode: Hex }
    const stable18 = await dep(tokenArtifact, ['Mock stable 18', 'mUSD18', 18])
    d.tokens.mUSD18 = stable18
    for (const wallet of [ctx.maker, ctx.taker]) await send(ctx, ctx.maker, { to: stable18,
      data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: 'mint', args: [wallet.account.address, 100_000n * 10n ** 18n] }) }, 'mint-stable', rec)
    const forwarder = await dep(guardTestForwarderArtifact, [])
    const guard = await dep(guardArtifact, [forwarder, d.router, zeroHash, zeroAddress, true])
    let salt = 9000
    const params = (): AquaStrategyParams => ({ schema: 'aqua-swapvm-v1.0.2', chainId: 31337, maker: ctx.maker.account.address,
      tokens: [d.tokens.mUSDC!, stable18], amounts: ['1000000000', '1000000000000000000000'],
      program: { kind: 'pegged', feeBps: 0, deadline: 2_000_000_000, salt: String(salt++),
        referenceBalances: ['1000000000', '1000000000000000000000'], rates: ['1000000000000', '1'], linearWidth: '1000000000000000000000000000' },
      meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: 1 } })
    const caps: GuardCaps = { maxAmount0PerSwap: 100_000_000n, maxAmount1PerSwap: 100n * 10n ** 18n,
      maxPostBalance0: 1_200_000_000n, maxPostBalance1: 1200n * 10n ** 18n }
    const activate = async (s: GuardedCompiled, c = caps) => {
      for (const [i, token] of s.tokens.entries()) await send(ctx, ctx.maker, buildTx.approve(token, d.aqua, i ? c.maxPostBalance1 : c.maxPostBalance0), 'approve', rec)
      await send(ctx, ctx.maker, buildTx.ship(d, s), 'ship', rec)
    }
    const submit = async (s: GuardedCompiled, patch: Partial<GuardReport> = {}, c = caps) => {
      const now = Number((await ctx.pc.getBlock()).timestamp)
      const r: GuardReport = { schemaVersion: 1, chainId: 31337n, guard: s.guard, router: d.router, maker: s.params.maker,
        strategyHash: s.strategyHash, token0: s.tokens[0]!, token1: s.tokens[1]!, nonce: 1n, validAfter: now, validUntil: now + 600,
        allowedDirections: 3, ...c, ...patch }
      await send(ctx, ctx.maker, buildTestReportTx(forwarder, s.guard, r), 'synthetic-report', rec)
    }
    return { ctx, d, rec, dir, rpc, dep, guard, forwarder, params, caps, activate, submit, close: () => { anvil.kill() } }
  } catch (e) { anvil.kill(); throw e }
}
