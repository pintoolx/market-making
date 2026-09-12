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
    error('incompatible-deployment', 'profile', 'Source／SDK／opcode／Guard profile 尚未核對相容性')
  }
  if (spec.profileId !== profile.id) error('profile-mismatch', 'spec.profileId', '草稿與部署 profile 不相符')
  const need = (field: string, value: unknown) => { if (value === undefined) missingFields.push(field) }
  need('spec.baseToken', spec.baseToken); need('spec.quoteToken', spec.quoteToken); need('spec.model', spec.model)
  need('spec.feeBps', spec.feeBps); need('spec.deadline', spec.deadline); need('spec.guardEnvelope', spec.guardEnvelope)
  for (const name of ['baseToken', 'quoteToken'] as const) {
    const token = spec[name]
    if (!token) continue
    const verified = profile.tokens.find(t => t.address.toLowerCase() === token.address)
    if (!verified || verified.decimals !== token.decimals || verified.symbol !== token.symbol) error('unverified-token', `spec.${name}`, '幣種與已核對 metadata 不符，請重新 resolve token')
  }
  if (spec.baseToken && spec.baseToken.address === spec.quoteToken?.address) error('duplicate-token', 'spec.quoteToken', '交易對必須是不同 token')
  if (spec.deadline !== undefined && spec.deadline <= nowSec) error('expired', 'spec.deadline', '策略 deadline 已到期')
  if (spec.feeBps !== undefined && spec.feeBps !== 0) error('fee-accounting-unverified', 'spec.feeBps', '非零 LP 費率與 Guard accounting 尚待組合驗證')
  if (new Set(draft.requirements.map(r => r.id)).size !== draft.requirements.length) error('duplicate-requirement', 'requirements', '需求識別碼重複')
  const modifiers = new Set<string>()
  for (const [i, modifier] of spec.modifiers.entries()) {
    if (modifiers.has(modifier.kind)) error('duplicate-modifier', `spec.modifiers.${i}`, '不能重複套用 modifier')
    modifiers.add(modifier.kind)
    error('composition-unverified', `spec.modifiers.${i}`, `${modifier.kind} 尚未完成此 profile 的 Guard 組合驗證`)
  }
  if (spec.model?.kind === 'concentrated') {
    const m = spec.model
    if (m.relativeWidthBps !== undefined) {
      if (m.minPrice !== undefined || m.maxPrice !== undefined) error('ambiguous-range', 'spec.model', '固定價格與相對價格模板須擇一；固定 snapshot 後移除相對設定')
      if (draft.kind === 'maker') missingFields.push('spec.model.fixedSnapshotRange')
    } else {
      need('spec.model.minPrice', m.minPrice); need('spec.model.maxPrice', m.maxPrice)
      if (m.minPrice && m.maxPrice && scaledDecimal(m.minPrice) >= scaledDecimal(m.maxPrice)) error('invalid-range', 'spec.model', '最低價必須小於最高價')
    }
    if (m.snapshot && (m.snapshot.baseToken !== spec.baseToken?.address || m.snapshot.quoteToken !== spec.quoteToken?.address)) error('snapshot-pair-mismatch', 'spec.model.snapshot', '價格 snapshot 的交易對不符')
  }
  if (spec.model?.kind === 'pegged') {
    need('spec.model.referencePrice', spec.model.referencePrice); need('spec.model.amplification', spec.model.amplification)
    if (spec.model.amplification && scaledDecimal(spec.model.amplification) > 5000n * 10n ** 18n) error('amplification-range', 'spec.model.amplification', 'Amplification 最大為 5000')
  }
  if (draft.kind === 'maker') {
    need('maker', draft.maker); need('allocations', draft.allocations)
    if (draft.allocations && spec.guardEnvelope) {
      if (BigInt(draft.allocations.baseAtomic) > BigInt(spec.guardEnvelope.maxPostBalanceBase) ||
        BigInt(draft.allocations.quoteAtomic) > BigInt(spec.guardEnvelope.maxPostBalanceQuote)) error('inventory-above-envelope', 'allocations', '初始 allocation 超出不可變 Guard envelope')
    }
  }
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
