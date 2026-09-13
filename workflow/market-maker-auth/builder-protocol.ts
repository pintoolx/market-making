import { z } from 'zod'
import { encodePublicReport, publicReportSchema, type PublicReport } from '../guard-report/report'

const uint = (bits: number) => z.string().regex(/^(0|[1-9][0-9]*)$/).max(78)
  .pipe(z.string().refine(value => BigInt(value) < (1n << BigInt(bits))))
export const builderRequestSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('evaluate') }).strict(),
  z.object({ phase: z.literal('deliver'), deliveryId: z.string().uuid(), nonce: uint(64).refine(value => value !== '0'),
    validAfter: uint(48), termsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(),
])
export const builderEnvelopeSchema = publicReportSchema.innerType().pick({
  maxAmount0PerSwap: true, maxAmount1PerSwap: true, maxPostBalance0: true, maxPostBalance1: true,
})

/** Stable identity of enforceable standing terms, excluding issuance/replay fields. */
export function standingTermsHash(input: unknown) {
  const { report } = encodePublicReport(input)
  if (report.schemaVersion !== '2') throw new Error('Builder requires standing Maker consent')
  return encodePublicReport({ ...report, nonce: '1', validAfter: '0' }).digest
}

export function clampBuilderReport(input: unknown, envelope: z.infer<typeof builderEnvelopeSchema>, balances: { balance0: string; balance1: string }): PublicReport {
  const { report } = encodePublicReport(input)
  const bounded = { ...report }
  for (const key of ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'] as const)
    bounded[key] = String(BigInt(report[key]) < BigInt(envelope[key]) ? report[key] : envelope[key])
  let directions = Number(bounded.allowedDirections)
  if (BigInt(balances.balance0) >= BigInt(bounded.maxPostBalance0)) directions &= ~1
  if (BigInt(balances.balance1) >= BigInt(bounded.maxPostBalance1)) directions &= ~2
  if (bounded.maxAmount0PerSwap === '0' || bounded.maxAmount1PerSwap === '0') directions = 0
  bounded.allowedDirections = String(directions)
  if (!directions) for (const key of ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'] as const) bounded[key] = '0'
  return encodePublicReport(bounded).report
}

export function prepareBuilderDelivery(input: unknown, request: z.infer<typeof builderRequestSchema>, now: number) {
  const { report } = encodePublicReport(input), termsHash = standingTermsHash(report)
  if (request.phase !== 'deliver') throw new Error('Builder delivery request required')
  const issued = BigInt(request.validAfter)
  if (issued > BigInt(now) || BigInt(now) - issued > 300n) return { status: 'stale' as const, reason: 'candidate-expired' }
  if (termsHash !== request.termsHash.toLowerCase()) return { status: 'stale' as const, reason: 'authorization-changed' }
  return { status: 'ready' as const, termsHash, ...encodePublicReport({ ...report, nonce: request.nonce, validAfter: request.validAfter }) }
}
