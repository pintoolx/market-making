import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { x25519 } from '@noble/curves/ed25519'
import { openConfidentialEnvelope } from '../../../../workflow/src/confidential-envelope.ts'
import { providerStrategySchema } from '../../../../workflow/src/types.ts'
import { computeAuthorization } from '../../../../workflow/src/intersect.ts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'

/** Owned fixture key held by this local test process only; never returned to a browser or logged. */
const key = randomBytes(32)
export const publicKey = Buffer.from(x25519.getPublicKey(key)).toString('hex')
export function checkFixturePolicy(envelope, provider, strategyId) {
  const policy = providerStrategySchema.parse(JSON.parse(openConfidentialEnvelope(envelope, key.toString('hex'), provider, 'provider')))
  assert.equal(policy.strategyId, strategyId); assert.equal(policy.rules.length, 3)
  assert.deepEqual(policy.rules[0].when, { volatilityBpsMin: 200 })
  assert.deepEqual(policy.rules[1].when, { priceMin: '2345.12345678', priceMax: '2678.12345678', volatilityBpsMax: 199 })
  assert.equal(policy.rules[1].maxAmount0PerSwap, '10000000000000000')
  assert.equal(policy.rules[1].maxAmount1PerSwap, '100000000')
  assert.equal(policy.rules[2].maxAmount0PerSwap, '20000000000000000')
  assert.equal(policy.rules[2].maxAmount1PerSwap, '50000000')
  for (const [midPrice, volatilityBps, direction] of [['2500', 300, 0], ['2500', 10, 1], ['3000', 10, 2]]) {
    const result = computeAuthorization({ strategy: policy, limits: { schemaVersion: 3, authorization: 'until-changed', maxBudget1: '15000000000',
      maxToken0ShareBps: 10000, maxToken0Value1: '10000000000', maxSwapValue1: '200000000' },
      market: { midPrice, volatilityBps, balance0: '10000000000000000', balance1: '25000000', decimals0: 18, decimals1: 6 },
      identity: { chainId: BigInt(profile.chainId), guard: profile.guard, router: profile.router, maker: '0x2222222222222222222222222222222222222222',
        strategyHash: '0x' + '11'.repeat(32), token0: profile.tokens[0].address, token1: profile.tokens[1].address }, nowSec: Math.floor(Date.now() / 1000), nonce: 1n })
    assert.equal(result.report.allowedDirections, direction); assert.equal(result.report.schemaVersion, 2); assert.equal(result.report.validUntil, 0)
  }
  assert.throws(() => openConfidentialEnvelope(envelope, key.toString('hex'), '0x2222222222222222222222222222222222222222', 'provider'))
  return { verified: true, scope: 'local-fixture-decryption-and-existing-evaluator', teeVerified: false }
}
