import { draftSchema, sepoliaStandingProfile as profile } from '@pintool/strategy-builder'

/** Public acceptance inputs; callers choose fresh, unfunded identities. */
export function builderSimulationFixture(kind: 'xyc' | 'concentrated' | 'pegged', maker: string, nowSec = Math.floor(Date.now() / 1000)) {
  const now = new Date(nowSec * 1000).toISOString()
  return draftSchema.parse({ schemaVersion: 1, id: `fork-${kind}`, owner: `wallet:${maker}`, revision: 1, kind: 'maker', maker,
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' }, salt: '100', createdAt: now, updatedAt: now, requirements: [],
    spec: { title: 'Public local fork fixture', profileId: profile.id, baseToken: profile.tokens[0], quoteToken: profile.tokens[1],
      model: kind === 'xyc' ? { kind } : kind === 'concentrated' ? { kind, minPrice: '2200', maxPrice: '2800' } : { kind, referencePrice: '2500', amplification: '1' },
      feeBps: 0, deadline: nowSec + 86400,
      guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' },
    } })
}
