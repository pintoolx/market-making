import { z } from 'zod'
import { addressSchema, decimalSchema, draftSchema, hashSchema, idSchema, positiveDecimalSchema, requirementSchema,
  revisionSchema, snapshotSchema, specSchema, type DraftPatch, type StrategyDraft, type StrategySpec } from './schema.ts'
import { canonical, contentDigest, digestJson, DraftConflict, diffDrafts, patchDraft } from './drafts.ts'
import { scaledDecimal, validateStrategy, type DeploymentProfile } from './validation.ts'

const priceRange = z.object({ min: positiveDecimalSchema, max: positiveDecimalSchema }).strict()
  .refine(v => scaledDecimal(v.min) <= scaledDecimal(v.max), 'invalid parameter range')
const amplificationRange = z.object({ min: decimalSchema, max: decimalSchema }).strict()
  .refine(v => scaledDecimal(v.min) <= scaledDecimal(v.max) && scaledDecimal(v.max) <= 5000n * 10n ** 18n, 'invalid amplification range')
export const templatePermissionsSchema = z.object({
  tightenCaps: z.boolean(), shortenDeadline: z.boolean(), narrowConcentratedRange: z.boolean(),
  peggedReferencePrice: priceRange.nullable(), peggedAmplification: amplificationRange.nullable(),
}).strict()
export const defaultTemplatePermissions = { tightenCaps: true, shortenDeadline: true, narrowConcentratedRange: true,
  peggedReferencePrice: null, peggedAmplification: null } satisfies z.infer<typeof templatePermissionsSchema>

/** Public version document. Ciphertext, private rules and decryption diagnostics are deliberately absent. */
export const templateVersionSchema = z.object({
  schemaVersion: z.literal(1), templateId: idSchema, version: revisionSchema, provider: addressSchema,
  manifestHash: hashSchema, source: z.object({ draftId: idSchema, revision: revisionSchema, contentDigest: hashSchema }).strict(),
  spec: specSchema, requirements: z.array(requirementSchema).max(100), permissions: templatePermissionsSchema,
  policy: z.object({ keyId: hashSchema, envelopeDigest: hashSchema }).strict(), createdAt: z.string().datetime(),
}).strict()
export type TemplateVersion = z.infer<typeof templateVersionSchema>
export type TemplatePermissions = z.infer<typeof templatePermissionsSchema>
export type PriceSnapshot = z.infer<typeof snapshotSchema>
export const templateDigest = (version: TemplateVersion) => digestJson(templateVersionSchema.parse(version))

export function makeTemplateVersion(draftInput: StrategyDraft, profile: DeploymentProfile, identity: {
  templateId: string; version: number; permissions: TemplatePermissions; policy: TemplateVersion['policy']; now: string;
}) {
  const draft = draftSchema.parse(draftInput), now = Math.floor(Date.parse(identity.now) / 1000)
  if (draft.kind !== 'template' || !/^wallet:0x[0-9a-f]{40}$/.test(draft.owner)) throw new DraftConflict('provider-template-required')
  if (!validateStrategy(draft, profile, now).ready) throw new DraftConflict('template-incomplete-or-invalid')
  if (draft.spec.model?.kind === 'concentrated' && draft.spec.model.snapshot) throw new DraftConflict('provider-snapshot-not-allowed')
  const permissions = templatePermissionsSchema.parse(identity.permissions)
  if (draft.spec.model?.kind !== 'pegged' && (permissions.peggedReferencePrice || permissions.peggedAmplification)) throw new DraftConflict('permission-curve-mismatch')
  const version = templateVersionSchema.parse({ schemaVersion: 1, templateId: identity.templateId, version: identity.version, provider: draft.owner.slice(7),
    manifestHash: digestJson(profile), source: { draftId: draft.id, revision: draft.revision, contentDigest: contentDigest(draft) },
    spec: draft.spec, requirements: draft.requirements, permissions, policy: identity.policy, createdAt: identity.now })
  if (version.spec.model?.kind === 'pegged') for (const [value, range] of [[version.spec.model.referencePrice, permissions.peggedReferencePrice],
    [version.spec.model.amplification, permissions.peggedAmplification]] as const) {
    if (range && value && (scaledDecimal(value) < scaledDecimal(range.min) || scaledDecimal(value) > scaledDecimal(range.max))) throw new DraftConflict('template-outside-permission-range')
  }
  return version
}

const decimal = (atomic: bigint) => {
  const whole = atomic / 10n ** 18n, fraction = String(atomic % 10n ** 18n).padStart(18, '0').replace(/0+$/, '')
  return String(whole) + (fraction ? '.' + fraction : '')
}
/** Only the server's trusted price adapter may supply this observation. The
 * application checks freshness; this pure resolver fixes an immutable range. */
export function resolveTemplateSpec(templateInput: TemplateVersion, observation?: PriceSnapshot): StrategySpec {
  const template = templateVersionSchema.parse(templateInput), spec = structuredClone(template.spec), model = spec.model
  if (model?.kind !== 'concentrated' || model.relativeWidthBps === undefined) {
    if (observation) throw new DraftConflict('unexpected-price-snapshot')
    return spec
  }
  if (!observation) throw new DraftConflict('price-snapshot-required')
  const snapshot = snapshotSchema.parse(observation)
  if (snapshot.baseToken !== spec.baseToken?.address || snapshot.quoteToken !== spec.quoteToken?.address) throw new DraftConflict('snapshot-pair-mismatch')
  const price = scaledDecimal(snapshot.price), width = BigInt(model.relativeWidthBps)
  // Round inward at 18 decimals before the compiler rounds sqrt-price bounds inward again.
  const lower = price * (10000n - width), upper = price * (10000n + width)
  const min = (lower + 9999n) / 10000n, max = upper / 10000n
  if (min === 0n || min >= max) throw new DraftConflict('relative-range-collapses')
  spec.model = { kind: 'concentrated', minPrice: decimal(min), maxPrice: decimal(max), snapshot }
  return specSchema.parse(spec)
}

/** Validate actual effective instance parameters against its signed version and
 * immutable server-resolved baseline. The application authenticates that context. */
export function assertTemplateInstance(draftInput: StrategyDraft, templateInput: TemplateVersion, resolvedInput: StrategySpec) {
  const draft = draftSchema.parse(draftInput), template = templateVersionSchema.parse(templateInput), baseline = specSchema.parse(resolvedInput)
  if (draft.kind !== 'maker' || !draft.templatePin || draft.templatePin.templateId !== template.templateId ||
    draft.templatePin.version !== template.version || draft.templatePin.digest !== templateDigest(template)) throw new DraftConflict('template-pin-mismatch')
  const snapshot = baseline.model?.kind === 'concentrated' ? baseline.model.snapshot : undefined
  const resolved = resolveTemplateSpec(template, snapshot)
  if (canonical(baseline) !== canonical(resolved)) throw new DraftConflict('template-baseline-mismatch')
  const fixed = (spec: StrategySpec) => ({ profileId: spec.profileId, baseToken: spec.baseToken, quoteToken: spec.quoteToken,
    feeBps: spec.feeBps, modifiers: spec.modifiers, kind: spec.model?.kind })
  if (canonical(fixed(draft.spec)) !== canonical(fixed(baseline))) throw new DraftConflict('template-fixed-parameter')
  const a = draft.spec.guardEnvelope, b = baseline.guardEnvelope, permissions = template.permissions
  for (const field of ['maxAmountBasePerSwap','maxAmountQuotePerSwap','maxPostBalanceBase','maxPostBalanceQuote'] as const) {
    if (!a?.[field] || !b?.[field] || BigInt(a[field]) > BigInt(b[field]) || (!permissions.tightenCaps && a[field] !== b[field])) throw new DraftConflict('template-cap-permission')
  }
  if (draft.spec.deadline === undefined || baseline.deadline === undefined || draft.spec.deadline > baseline.deadline ||
    (!permissions.shortenDeadline && draft.spec.deadline !== baseline.deadline)) throw new DraftConflict('template-deadline-permission')
  const current = draft.spec.model, original = baseline.model
  if (current?.kind === 'concentrated' && original?.kind === 'concentrated') {
    if (current.relativeWidthBps !== undefined || canonical(current.snapshot ?? null) !== canonical(original.snapshot ?? null) ||
      !current.minPrice || !current.maxPrice || !original.minPrice || !original.maxPrice) throw new DraftConflict('template-range-permission')
    const lo = scaledDecimal(current.minPrice), hi = scaledDecimal(current.maxPrice), baseLo = scaledDecimal(original.minPrice), baseHi = scaledDecimal(original.maxPrice)
    if (lo >= hi || lo < baseLo || hi > baseHi || (!permissions.narrowConcentratedRange && (lo !== baseLo || hi !== baseHi))) throw new DraftConflict('template-range-permission')
  } else if (current?.kind === 'pegged' && original?.kind === 'pegged') {
    for (const [field, range] of [['referencePrice', permissions.peggedReferencePrice], ['amplification', permissions.peggedAmplification]] as const) {
      if (current[field] === undefined || original[field] === undefined) throw new DraftConflict('template-pegged-permission')
      if (!range ? scaledDecimal(current[field]) !== scaledDecimal(original[field]) :
        scaledDecimal(current[field]) < scaledDecimal(range.min) || scaledDecimal(current[field]) > scaledDecimal(range.max)) throw new DraftConflict('template-pegged-permission')
    }
  }
}

/** The ordinary patch function continues to reject pinned spec edits. Only the
 * application path holding authenticated immutable template context calls this. */
export function patchTemplateInstance(current: StrategyDraft, input: DraftPatch, template: TemplateVersion, baseline: StrategySpec,
  context: Parameters<typeof patchDraft>[2]) {
  assertTemplateInstance(current, template, baseline)
  const result = patchDraft({ ...current, templatePin: undefined }, input, context)
  const draft = draftSchema.parse({ ...result.draft, templatePin: current.templatePin })
  if (draft.maker !== current.maker) throw new DraftConflict('template-maker-immutable')
  assertTemplateInstance(draft, template, baseline)
  return { draft, changed: result.changed, diff: diffDrafts(current, draft) }
}
