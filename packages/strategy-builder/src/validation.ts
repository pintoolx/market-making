import { getCapabilities, AQUA_OPCODES, AQUA_COMMIT, SWAPVM_COMMIT } from './capabilities.ts'
import { digestJson, contentDigest } from './drafts.ts'
import { draftSchema, type StrategyDraft, type Token } from './schema.ts'

export interface DeploymentProfile {
  id: string; chainId: number; router: `0x${string}`; aqua: `0x${string}`;
  guard: `0x${string}`; forwarder: `0x${string}`; guardRevision: 'standing-v2';
  swapVmCommit: string; aquaCommit: string; swapVmSdk: string; aquaSdk: null;
  tokens: readonly Token[]; opcodeTableHash: `0x${string}`;
}
export interface ValidationIssue { code: string; path: string; message: string }
export interface ValidatedStrategy {
  draft: StrategyDraft; contentDigest: `0x${string}`; manifestHash: `0x${string}`;
  profile: DeploymentProfile; recipeId: string;
}
export const scaledDecimal = (value: string, decimals = 18): bigint => {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36 || !/^(0|[1-9]\d{0,35})(\.\d+)?$/.test(value)) throw new Error('invalid decimal')
  const [whole = '0', fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new Error('too many decimal places')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}
export function validateStrategy(input: unknown, profile: DeploymentProfile, nowSec: number) {
  const parsed = draftSchema.safeParse(input)
  const errors: ValidationIssue[] = [], missingFields: string[] = []
  const error = (code: string, path: string, message: string) => errors.push({ code, path, message })
  if (!parsed.success) return { ready: false as const, errors: parsed.error.issues.map(i => ({ code: 'schema', path: i.path.join('.'), message: i.message })), missingFields, validated: null }
  const draft = parsed.data, spec = draft.spec
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new Error('a trusted evaluation time is required')
  if (profile.swapVmCommit !== SWAPVM_COMMIT || profile.aquaCommit !== AQUA_COMMIT || profile.swapVmSdk !== '0.4.4' ||
    profile.guardRevision !== 'standing-v2' || profile.opcodeTableHash !== digestJson(AQUA_OPCODES)) {
    error('incompatible-deployment', 'profile', 'Source, SDK, opcode and Guard profile compatibility is not verified')
  }
  if (spec.profileId !== profile.id) error('profile-mismatch', 'spec.profileId', 'Draft and deployment profiles do not match')
  const need = (field: string, value: unknown) => { if (value === undefined) missingFields.push(field) }
  need('spec.baseToken', spec.baseToken); need('spec.quoteToken', spec.quoteToken); need('spec.model', spec.model)
  need('spec.feeBps', spec.feeBps); need('spec.deadline', spec.deadline); need('spec.guardEnvelope', spec.guardEnvelope)
  if (spec.guardEnvelope) for (const field of ['maxAmountBasePerSwap', 'maxAmountQuotePerSwap', 'maxPostBalanceBase', 'maxPostBalanceQuote'] as const) {
    need(`spec.guardEnvelope.${field}`, spec.guardEnvelope[field])
  }
  for (const name of ['baseToken', 'quoteToken'] as const) {
    const token = spec[name]
    if (!token) continue
    const verified = profile.tokens.find(t => t.address.toLowerCase() === token.address)
    if (!verified || verified.decimals !== token.decimals || verified.symbol !== token.symbol) error('unverified-token', `spec.${name}`, 'Token metadata does not match verified metadata; resolve the token again')
  }
  if (spec.baseToken && spec.baseToken.address === spec.quoteToken?.address) error('duplicate-token', 'spec.quoteToken', 'The pair must contain different tokens')
  if (spec.deadline !== undefined && spec.deadline <= nowSec) error('expired', 'spec.deadline', 'The strategy deadline has expired')
  if (new Set(draft.requirements.map(r => r.id)).size !== draft.requirements.length) error('duplicate-requirement', 'requirements', 'Duplicate requirement IDs')
  const modifiers = new Set<string>()
  for (const [i, modifier] of spec.modifiers.entries()) {
    if (modifiers.has(modifier.kind)) error('duplicate-modifier', `spec.modifiers.${i}`, 'A modifier cannot be applied twice')
    modifiers.add(modifier.kind)
    error('composition-unverified', `spec.modifiers.${i}`, `${modifier.kind} has not passed Guard composition verification for this profile`)
  }
  if (spec.model?.kind === 'concentrated') {
    const m = spec.model
    if (m.relativeWidthBps !== undefined) {
      if (m.minPrice !== undefined || m.maxPrice !== undefined) error('ambiguous-range', 'spec.model', 'Choose fixed or relative prices; remove relative settings after fixing the snapshot')
      if (draft.kind === 'maker') missingFields.push('spec.model.fixedSnapshotRange')
    } else {
      need('spec.model.minPrice', m.minPrice); need('spec.model.maxPrice', m.maxPrice)
      if (m.minPrice && m.maxPrice && scaledDecimal(m.minPrice) >= scaledDecimal(m.maxPrice)) error('invalid-range', 'spec.model', 'Minimum price must be below maximum price')
    }
    if (m.snapshot && (m.snapshot.baseToken !== spec.baseToken?.address || m.snapshot.quoteToken !== spec.quoteToken?.address)) error('snapshot-pair-mismatch', 'spec.model.snapshot', 'The price snapshot uses a different token pair')
  }
  if (spec.model?.kind === 'pegged') {
    need('spec.model.referencePrice', spec.model.referencePrice); need('spec.model.amplification', spec.model.amplification)
    if (spec.model.amplification && scaledDecimal(spec.model.amplification) > 5000n * 10n ** 18n) error('amplification-range', 'spec.model.amplification', 'Amplification must not exceed 5000')
  }
  if (draft.kind === 'maker') {
    need('maker', draft.maker); need('allocations', draft.allocations)
    if (draft.allocations) { need('allocations.baseAtomic', draft.allocations.baseAtomic); need('allocations.quoteAtomic', draft.allocations.quoteAtomic) }
    if (draft.allocations && spec.guardEnvelope) {
      for (const [amount, cap] of [[draft.allocations.baseAtomic, spec.guardEnvelope.maxPostBalanceBase], [draft.allocations.quoteAtomic, spec.guardEnvelope.maxPostBalanceQuote]]) {
        if (amount !== undefined && cap !== undefined && BigInt(amount) > BigInt(cap)) error('inventory-above-envelope', 'allocations', 'Initial allocations exceed the immutable Guard envelope')
      }
    }
  } else if (draft.maker || draft.allocations) error('template-instance-fields', 'allocations', 'Provider templates cannot contain Maker addresses or asset allocations')
  const ready = !errors.length && !missingFields.length
  return { ready, errors, missingFields, validated: ready ? {
    draft, contentDigest: contentDigest(draft), manifestHash: digestJson(profile), profile: structuredClone(profile),
    recipeId: `guarded-${spec.model!.kind}-v2`,
  } satisfies ValidatedStrategy : null }
}

/** Availability is not proof that arbitrary natural-language text is enforced. Confirmation uses decoded artifacts. */
export function assessRequirements(draft: StrategyDraft) {
  return draft.requirements.map(r => ({ id: r.id, priority: r.priority, text: r.text,
    capabilities: r.capabilityIds.map(id => {
      const capability = getCapabilities({ ids: [id] })[0]
      return { id, available: capability?.productEnabled.state === 'verified', reason: capability?.productEnabled.reason ?? 'unknown capability' }
    }),
    status: r.userAcceptedAlternative ? 'alternative-accepted' as const : 'needs-artifact-review' as const,
  }))
}
