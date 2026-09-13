import { expect, test } from 'bun:test'
import fixture from '../../docs/guard-report-v1/example.json'
import { builderRequestSchema, clampBuilderReport, prepareBuilderDelivery, standingTermsHash } from './builder-protocol'
import { encodePublicReport } from '../guard-report/report'
import { builderMakerLimitsSchema } from '../src/types'

const report = encodePublicReport({ ...fixture.report, schemaVersion: '2', validUntil: '0' }).report
const now = Number(report.validAfter)
const request = { phase: 'deliver' as const, deliveryId: '12345678-1234-4234-8234-123456789012',
  nonce: '18446744073709551614', validAfter: report.validAfter, termsHash: standingTermsHash(report) }

test('standing identity covers every term except issuance time and nonce', () => {
  expect(standingTermsHash({ ...report, nonce: '19', validAfter: String(now + 60) })).toBe(request.termsHash)
  for (const key of ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'] as const)
    expect(standingTermsHash({ ...report, [key]: String(BigInt(report[key]) + 1n) })).not.toBe(request.termsHash)
  expect(standingTermsHash({ ...report, maker: report.router })).not.toBe(request.termsHash)
  expect(() => standingTermsHash(fixture.report)).toThrow('standing')
})

test('delivery preserves exact persisted uint64 and issuance; stale evaluations cannot broadcast', () => {
  const result = prepareBuilderDelivery({ ...report, nonce: '23', validAfter: String(now + 20) }, request, now + 20)
  expect(result.status).toBe('ready')
  if (result.status === 'ready') expect(result.report).toEqual({ ...report, nonce: request.nonce })
  expect(prepareBuilderDelivery(report, request, now + 301)).toMatchObject({ status: 'stale', reason: 'candidate-expired' })
  expect(prepareBuilderDelivery(report, request, now - 1)).toMatchObject({ status: 'stale' })
  expect(prepareBuilderDelivery({ ...report, allowedDirections: '1' }, request, now)).toMatchObject({ status: 'stale', reason: 'authorization-changed' })
})

test('public Builder caps can only tighten; full inventory disables the corresponding direction', () => {
  const envelope = { maxAmount0PerSwap: report.maxAmount0PerSwap, maxAmount1PerSwap: report.maxAmount1PerSwap,
    maxPostBalance0: report.maxPostBalance0, maxPostBalance1: report.maxPostBalance1 }
  expect(clampBuilderReport(report, envelope, { balance0: envelope.maxPostBalance0, balance1: '0' }).allowedDirections).toBe('2')
  const pause = clampBuilderReport(report, { ...envelope, maxAmount1PerSwap: '0' }, { balance0: '0', balance1: '0' })
  expect(pause.allowedDirections).toBe('0')
  for (const key of Object.keys(envelope)) expect(pause[key as keyof typeof pause]).toBe('0')
})

test('strict protocol rejects private fields, malformed and overflowing integers', () => {
  for (const nonce of ['0', '01', '-1', 'NaN', '18446744073709551616'])
    expect(builderRequestSchema.safeParse({ ...request, nonce }).success).toBe(false)
  expect(builderRequestSchema.safeParse({ phase: 'evaluate', privatePolicy: 'canary' }).success).toBe(false)
  const limits = { schemaVersion: 4, authorization: 'until-changed', maxAmount0PerSwap: '1', maxAmount1PerSwap: '1', maxPostBalance0: '1', maxPostBalance1: '1' }
  for (const maxPostBalance0 of ['x', '01', String(1n << 128n)]) expect(builderMakerLimitsSchema.safeParse({ ...limits, maxPostBalance0 }).success).toBe(false)
})
