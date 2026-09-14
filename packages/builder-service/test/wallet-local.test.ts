import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zeroHash, zeroAddress, type Abi } from 'viem'
import { draftSchema, sepoliaStandingProfile, type DeploymentProfile } from '@pintool/strategy-builder'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { lpFixture } from '../../../contracts/aqua-executor/test/helpers/lp.ts'
import { readJson } from '../../../contracts/aqua-executor/src/config.ts'
import { waitMined } from '../../../contracts/aqua-executor/src/executor.ts'
import { makePlan, type PlanKind } from '../src/transaction-plans.ts'
import { createWalletChain } from '../src/wallet-chain.ts'

test('actual local upstream contracts verify approvals, registration, direct revocation and docking for every curve', { skip: process.env.BUILDER_WALLET_LOCAL_TEST !== '1' }, async () => {
  const f = await lpFixture()
  try {
    const guard = await f.dep(readJson('artifacts/AquaGuardV2.json') as { abi: Abi; bytecode: `0x${string}` }, [f.forwarder, f.d.router, zeroHash, zeroAddress, true])
    const profile: DeploymentProfile = { ...sepoliaStandingProfile, id: 'local-standing-v2', chainId: 31337, router: f.d.router, aqua: f.d.aqua, guard,
      forwarder: f.forwarder, tokens: [{ address: f.d.tokens.mWETH!, symbol: 'WETH', decimals: 18 }, { address: f.d.tokens.mUSDC!, symbol: 'USDC', decimals: 6 }] }
    const chain = createWalletChain(profile, { client: f.ctx.pc, confirmations: 1 })
    let salt = 123000
    for (const kind of ['xyc','concentrated','pegged'] as const) {
      const now = new Date().toISOString(), maker = f.ctx.maker.account.address.toLowerCase(), draft = draftSchema.parse({ schemaVersion: 1,
        id: 'local-' + kind, owner: 'wallet:' + maker, kind: 'maker', maker, revision: 1, salt: String(salt++), requirements: [], createdAt: now, updatedAt: now,
        allocations: { baseAtomic: '1000000000000000', quoteAtomic: '2500000' }, spec: { title: kind, profileId: profile.id,
          baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: kind === 'xyc' ? { kind } : kind === 'concentrated' ? { kind, minPrice: '2000', maxPrice: '3000' } : { kind, referencePrice: '2500', amplification: '1' },
          feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 3600, guardEnvelope: { maxAmountBasePerSwap: '100000000000000', maxAmountQuotePerSwap: '250000', maxPostBalanceBase: '2000000000000000', maxPostBalanceQuote: '5000000' } } })
      const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))
      for (const operation of ['registration','guard-revoke','guard-unrevoke','cancellation','allowance-revoke'] as PlanKind[]) {
        const plan = makePlan(operation, 'local-' + operation, profile, draft, 'local-artifact', compiled)
        for (const step of plan.transactions.keys()) {
          const preflight = await chain.preflight(plan, step), r = preflight.request
          const hash = await f.ctx.maker.sendTransaction({ to: r.to, data: r.data, value: 0n, nonce: Number(r.nonce), gas: BigInt(r.gas) })
          await waitMined(f.ctx, hash)
          // Recover by Maker + nonce alone, as after a lost browser response.
          const evidence = await chain.reconcile(plan, step, { nonce: r.nonce, fromBlock: preflight.fromBlock, transactionHash: null })
          assert.equal(evidence?.state, 'confirmed', `${kind} ${operation} ${step}`)
          assert.equal(evidence?.transactionHash, hash)
        }
      }
    }
  } finally { f.close() }
})
