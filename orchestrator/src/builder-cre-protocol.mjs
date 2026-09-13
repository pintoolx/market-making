import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { encodeAbiParameters, keccak256, zeroAddress, zeroHash } from 'viem';

export const reportAbi = JSON.parse(readFileSync(new URL('../../docs/guard-report-v1/abi.json', import.meta.url), 'utf8'));
const uint = bits => z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine(s => /^(0|[1-9][0-9]*)$/.test(s) && s.length <= 78 && BigInt(s) < (1n << BigInt(bits)));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase()).refine(s => s !== zeroAddress);
export const reportSchema = z.object({
  schemaVersion: z.literal('2'), chainId: uint(256), guard: address, router: address, maker: address,
  strategyHash: hash.refine(s => s !== zeroHash), token0: address, token1: address,
  nonce: uint(64).refine(s => s !== '0'), validAfter: uint(48), validUntil: z.literal('0'),
  allowedDirections: z.enum(['0', '1', '2', '3']), maxAmount0PerSwap: uint(128), maxAmount1PerSwap: uint(128),
  maxPostBalance0: uint(128), maxPostBalance1: uint(128),
}).strict().refine(r => r.token0 !== r.token1 && (r.allowedDirections === '0' ||
  [r.maxAmount0PerSwap, r.maxAmount1PerSwap, r.maxPostBalance0, r.maxPostBalance1].every(s => s !== '0')));
export function encodeBuilderReport(input) {
  const report = reportSchema.parse(input);
  const tuple = Object.fromEntries(reportAbi[0].components.map(({ name, type }) => [name, type.startsWith('uint') ? BigInt(report[name]) : report[name]]));
  const payload = encodeAbiParameters(reportAbi, [tuple]);
  return { report, payload, digest: keccak256(payload) };
}
export const builderTermsHash = input => encodeBuilderReport({ ...reportSchema.parse(input), nonce: '1', validAfter: '0' }).digest;
const base = { kind: z.literal('builder-cre-result'), schemaVersion: z.literal(1), requestId: z.string(),
  evidenceMode: z.literal('cre-local-simulation'), termsHash: hash };
const resultSchema = z.union([
  z.object({ ...base, phase: z.literal('evaluate'), status: z.literal('evaluated'), report: reportSchema, observedAt: z.string().datetime() }).strict(),
  z.object({ ...base, phase: z.literal('deliver'), deliveryId: z.string().uuid(), status: z.literal('accepted'),
    nonce: uint(64), reportDigest: hash, transactionHash: hash.refine(s => s !== zeroHash) }).strict(),
  z.object({ ...base, phase: z.literal('deliver'), deliveryId: z.string().uuid(), status: z.literal('already-effective'),
    nonce: uint(64), reportDigest: hash }).strict(),
  z.object({ ...base, phase: z.literal('deliver'), deliveryId: z.string().uuid(), status: z.literal('stale'),
    reason: z.enum(['candidate-expired', 'authorization-changed', 'nonce-stale']) }).strict(),
]);

/** Consume only the explicit public marker, never CLI diagnostics or private input. */
export function parseBuilderCreOutput(stdout, request) {
  const results = [];
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const start = line.indexOf('{"kind":"builder-cre-result"');
    if (start < 0) continue;
    let value;
    try { value = resultSchema.parse(JSON.parse(line.slice(start))); } catch { throw new Error('builder-cre-invalid-result'); }
    results.push(value);
  }
  if (results.length !== 1) throw new Error('builder-cre-result-count');
  const result = results[0];
  if (result.requestId !== request.requestId || result.phase !== request.builder.phase ||
    (result.phase === 'deliver' && result.deliveryId !== request.builder.deliveryId)) throw new Error('builder-cre-identity-mismatch');
  if (result.phase === 'evaluate' && (result.report.maker !== request.maker.toLowerCase() || result.report.strategyHash !== request.strategyHash.toLowerCase() ||
    builderTermsHash(result.report) !== result.termsHash)) throw new Error('builder-cre-identity-mismatch');
  if (result.status === 'accepted' && (result.nonce !== request.builder.nonce || result.termsHash !== request.builder.termsHash.toLowerCase()))
    throw new Error('builder-cre-identity-mismatch');
  return result;
}
