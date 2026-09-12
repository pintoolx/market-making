// Optional integration test. Only the child Anvil receives writes; upstream Sepolia is read-only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { createWalletClient, http, parseAbi, parseEther, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey } from 'viem/accounts'
import { connect } from '../src/config.ts'
import { deploy } from '../src/deploy.ts'
import { waitMined } from '../src/executor.ts'
import { deploySepolia, fundSepolia, SEPOLIA } from '../src/sepolia.ts'
import { runLifecycle } from '../src/lifecycle.ts'
import { runGuardDemo } from '../src/guard-demo.ts'
import { recorder } from '../src/records.ts'

test('Sepolia fork: canonical assets, durable deployment/funding, lifecycle and concentrated Guard veto', {
  skip: !process.env.SEPOLIA_FORK_RPC_URL, timeout: 600_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-sepolia-fork-'))
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(r => server.close(() => r()))
  const rpc = `http://127.0.0.1:${port}`
  const anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', String(port), '--silent', '--chain-id', String(SEPOLIA.chainId), '--fork-url', process.env.SEPOLIA_FORK_RPC_URL!], { stdio: 'ignore' })
  let failed: Error | undefined; anvil.on('error', e => { failed = e })
  // Public Anvil addresses can already carry EIP-7702 delegation on upstream Sepolia.
  // Fresh local-only EOAs avoid inheriting unrelated code, balances or nonces.
  const ctx = connect(sepolia, rpc, generatePrivateKey(), generatePrivateKey())
  try {
    for (let i = 0; ; i++) {
      if (failed) throw failed
      try { await ctx.pc.getChainId(); break } catch (e) { if (i > 30) throw e; await sleep(100) }
    }
    const devRpc = async (method: string, params: unknown[]) => {
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const value = await response.json() as { result: unknown; error?: unknown }
      if (value.error) throw new Error(JSON.stringify(value.error))
      return value.result
    }
    // This identity is impersonated ONLY on the local fork to create a faucet-sized fixture.
    // No public USDC mint authority or faucet success is claimed.
    const issuerAbi = parseAbi(['function masterMinter() view returns (address)', 'function configureMinter(address minter, uint256 allowance) returns (bool)', 'function mint(address to, uint256 amount) returns (bool)'])
    const issuer = await ctx.pc.readContract({ address: SEPOLIA.USDC, abi: issuerAbi, functionName: 'masterMinter' })
    await devRpc('anvil_setBalance', [ctx.maker.account.address, `0x${parseEther('0.05').toString(16)}`])
    await devRpc('anvil_impersonateAccount', [issuer])
    await devRpc('anvil_setBalance', [issuer, `0x${parseEther('1').toString(16)}`])
    const admin = createWalletClient({ account: issuer, chain: sepolia, transport: http(rpc) })
    await waitMined(ctx, await admin.writeContract({ address: SEPOLIA.USDC, abi: issuerAbi, functionName: 'configureMinter', args: [ctx.maker.account.address, 20_000_000n] }))
    await waitMined(ctx, await ctx.maker.writeContract({ address: SEPOLIA.USDC, abi: issuerAbi, functionName: 'mint', args: [ctx.maker.account.address, 20_000_000n] }))
    await devRpc('anvil_stopImpersonatingAccount', [issuer])
    await devRpc('anvil_setBalance', [ctx.maker.account.address, `0x${parseEther('0.05').toString(16)}`])
    await devRpc('anvil_setBalance', [ctx.taker.account.address, '0x0'])
    const rec = recorder({ dir, runId: 'fork', chainId: SEPOLIA.chainId, explorer: null })
    await assert.rejects(deploy(ctx, rec), /mock deployment/)
    const options = { stateDir: join(dir, 'state') }
    let original: Hex | undefined
    await assert.rejects(deploySepolia(ctx, { ...options, onTransaction: e => {
      if (e.phase === 'broadcast' && e.step === 'AquaSwapVMRouter') { original = e.hash; throw new Error('interrupt router deployment') }
    } }), /interrupt router/)
    await waitMined(ctx, original!)
    const nonceAfterRouter = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
    const d = await deploySepolia(ctx, options)
    assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonceAfterRouter + 1)
    assert.equal((await ctx.pc.getTransactionReceipt({ hash: original! })).contractAddress?.toLowerCase(), d.router.toLowerCase())
    assert.deepEqual(await deploySepolia(ctx, options), d)
    assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonceAfterRouter + 1)
    assert.deepEqual(d.tokens, { WETH: SEPOLIA.WETH, USDC: SEPOLIA.USDC })
    assert.equal(d.guard?.profile, 'cre-simulation')
    await assert.rejects(fundSepolia(ctx, { ...options, onTransaction: e => {
      if (e.phase === 'broadcast' && e.step === 'wrap-weth') throw new Error('interrupt wrap')
    } }), /interrupt wrap/)
    await fundSepolia(ctx, options)
    const nonceAfterFunding = await ctx.pc.getTransactionCount({ address: ctx.maker.account.address })
    await fundSepolia(ctx, options)
    assert.equal(await ctx.pc.getTransactionCount({ address: ctx.maker.account.address }), nonceAfterFunding)
    const lifecycle = await runLifecycle(ctx, d, { rebalance: true, runId: 'official-assets', recordsDir: dir })
    assert.equal(lifecycle.swaps.length, 2)
    assert.ok(lifecycle.swaps.every(s => s.amountIn === 500_000n && s.amountOut > 0n))
    const demo = await runGuardDemo(ctx, d, dir)
    assert.equal(demo.guardVersion, 2)
    assert.ok(demo.finalState.every(b => b.tokensCount === 255 && b.balance === 0n))
    assert.equal((await ctx.pc.getTransactionReceipt({ hash: demo.rejectedSwap })).status, 'reverted')
    const logs = readFileSync(demo.file, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    const veto = logs.find(l => l.kind === 'guard-rejection-check')
    assert.deepEqual(veto.before, veto.after)
    console.log(`Local fork evidence only: ${dir}`)
  } finally { anvil.kill() }
})
