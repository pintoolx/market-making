import { encodeAbiParameters, isAddress, keccak256, zeroAddress, zeroHash, type Hex } from 'viem'
import { z } from 'zod'
import reportAbi from '../../docs/guard-report-v1/abi.json'

const uint = (bits: number) => z.string().regex(/^(0|[1-9][0-9]*)$/).max(78)
  .pipe(z.string().refine(s => BigInt(s) < 1n << BigInt(bits), `must fit uint${bits}`))
const address = z.string().refine(s => isAddress(s, { strict: false }) && s.toLowerCase() !== zeroAddress)
  .transform(s => s.toLowerCase() as Hex)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine(s => s.toLowerCase() !== zeroHash)
  .transform(s => s.toLowerCase() as Hex)

/** Only public derived bounds may cross this schema; unknown/private fields fail closed. */
export const publicReportSchema = z.object({
  schemaVersion: z.literal('1'), chainId: uint(256), guard: address, router: address, maker: address,
  strategyHash: hash, token0: address, token1: address, nonce: uint(64),
  validAfter: uint(48), validUntil: uint(48), allowedDirections: uint(8),
  maxAmount0PerSwap: uint(128), maxAmount1PerSwap: uint(128),
  maxPostBalance0: uint(128), maxPostBalance1: uint(128),
}).strict().superRefine((r, ctx) => {
  // Zod may run object refinements after a field refinement fails. Do not parse rejected input again.
  if ([r.allowedDirections, r.validAfter, r.validUntil].some(s => !/^(0|[1-9][0-9]*)$/.test(s) || s.length > 78)) return
  if (r.token0 === r.token1 || r.nonce === '0' || BigInt(r.allowedDirections) > 3n ||
    BigInt(r.validUntil) <= BigInt(r.validAfter) || BigInt(r.validUntil) - BigInt(r.validAfter) > 600n ||
    (r.allowedDirections !== '0' && [r.maxAmount0PerSwap, r.maxAmount1PerSwap, r.maxPostBalance0, r.maxPostBalance1].includes('0'))) {
    ctx.addIssue({ code: 'custom', message: 'invalid report pair, nonce, lifetime, directions or caps' })
  }
})
export type PublicReport = z.infer<typeof publicReportSchema>

export function encodePublicReport(input: unknown) {
  const parsed = publicReportSchema.safeParse(input)
  // Do not log validation inputs or unknown-field names from a confidential caller.
  if (!parsed.success) throw new Error('invalid public Guard report')
  const report = parsed.data
  const tuple = Object.fromEntries(reportAbi[0]!.components.map(({ name, type }) => [name,
    type.startsWith('uint') ? BigInt(report[name as keyof PublicReport]) : report[name as keyof PublicReport]]))
  const payload = encodeAbiParameters(reportAbi, [tuple])
  return { report, payload, digest: keccak256(payload) }
}

export function requireCurrent(report: PublicReport, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || BigInt(report.validAfter) > BigInt(now) || BigInt(report.validUntil) <= BigInt(now)) {
    throw new Error('Guard report is not current; do not regenerate it under the same nonce')
  }
}
