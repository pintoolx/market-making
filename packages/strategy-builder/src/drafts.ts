import { keccak256, stringToHex } from 'viem'
import { draftSchema, patchSchema, requirementInputSchema, type StrategyDraft } from './schema.ts'

/** Only validated JSON reaches this canonicalizer; no undefined, bigint or floating raw amounts. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('not a JSON value')
  return encoded
}
export const digestJson = (value: unknown) => keccak256(stringToHex(canonical(value)))

export class DraftConflict extends Error {}
export class DraftAccessDenied extends Error {}
export interface Diff { path: string; before: unknown; after: unknown }

function scope(draft: StrategyDraft, owner: string, revision: number) {
  if (draft.owner !== owner) throw new DraftAccessDenied('draft belongs to another user')
  if (draft.revision !== revision) throw new DraftConflict('draft changed; reload before applying this revision')
}
export function contentDigest(draft: StrategyDraft) {
  return digestJson({ kind: draft.kind, maker: draft.maker, allocations: draft.allocations, templatePin: draft.templatePin,
    spec: draft.spec, salt: draft.salt, requirements: draft.requirements })
}
export function diffDrafts(before: StrategyDraft, after: StrategyDraft): Diff[] {
  const rows: Diff[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === undefined && b === undefined) return
    if (a !== undefined && b !== undefined && canonical(a) === canonical(b)) return
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
      }
    } else rows.push({ path, before: a ?? null, after: b ?? null })
  }
  for (const key of ['spec', 'maker', 'allocations', 'requirements', 'templatePin'] as const) walk(before[key], after[key], key)
  return rows
}

/** Persistence performs the same expected-revision compare-and-swap inside its transaction. */
export function patchDraft(current: StrategyDraft, input: unknown, context: { owner: string; expectedRevision: number; now: string }) {
  const before = draftSchema.parse(current)
  scope(before, context.owner, context.expectedRevision)
  const patch = patchSchema.parse(input)
  if (before.kind === 'template' && (patch.maker || patch.allocations)) throw new DraftConflict('Maker allocation belongs to an instance, not a Provider template')
  // Template allowances are enforced by the application before patching a pinned instance.
  // This pure layer cannot independently authorize changes to somebody else's publication.
  if (before.templatePin && patch.spec) throw new DraftConflict('pinned template spec requires the template permission validator')
  const priced = before.spec.model && before.spec.model.kind !== 'xyc'
  for (const name of ['baseToken', 'quoteToken'] as const) {
    if (before.spec[name] && patch.spec?.[name] && before.spec[name]!.address !== patch.spec[name]!.address &&
      (before.allocations || before.spec.guardEnvelope || priced)) {
      throw new DraftConflict('changing a pair with existing amounts or price intent requires a new draft')
    }
  }
  const requirements = new Map(before.requirements.map(r => [r.id, r]))
  for (const id of patch.removeRequirementIds ?? []) requirements.delete(id)
  const inserted = new Set<string>()
  for (const next of patch.upsertRequirements ?? []) {
    if (inserted.has(next.id) || patch.removeRequirementIds?.includes(next.id)) throw new DraftConflict('contradictory requirement patch')
    inserted.add(next.id)
    const previous = requirements.get(next.id)
    const unchanged = previous && canonical(requirementInputSchema.parse({ id: previous.id, text: previous.text,
      priority: previous.priority, sourceMessageId: previous.sourceMessageId, capabilityIds: previous.capabilityIds })) === canonical(next)
    requirements.set(next.id, { ...next, userAcceptedAlternative: unchanged ? previous.userAcceptedAlternative : false })
  }
  const spec = { ...before.spec, ...patch.spec }
  if (patch.spec?.guardEnvelope) spec.guardEnvelope = { ...before.spec.guardEnvelope, ...patch.spec.guardEnvelope }
  if (patch.spec?.model && before.spec.model?.kind === patch.spec.model.kind) {
    spec.model = { ...before.spec.model, ...patch.spec.model }
    if (spec.model.kind === 'concentrated' && patch.spec.model.kind === 'concentrated') {
      if (patch.spec.model.relativeWidthBps !== undefined) {
        // Switching the intent back to a relative template cannot retain old fixed bounds.
        if (patch.spec.model.minPrice !== undefined || patch.spec.model.maxPrice !== undefined) throw new DraftConflict('choose a fixed or relative range')
        delete spec.model.minPrice; delete spec.model.maxPrice; delete spec.model.snapshot
      } else if (patch.spec.model.minPrice !== undefined || patch.spec.model.maxPrice !== undefined) {
        delete spec.model.relativeWidthBps
      }
    }
  }
  const candidate = draftSchema.parse({ ...before, spec,
    maker: patch.maker ?? before.maker,
    allocations: patch.allocations ? { ...before.allocations, ...patch.allocations } : before.allocations,
    requirements: [...requirements.values()], updatedAt: context.now })
  const diff = diffDrafts(before, candidate)
  if (!diff.length) return { draft: before, diff, changed: false }
  const draft = draftSchema.parse({ ...candidate, revision: before.revision + 1 })
  return { draft, diff, changed: true }
}

/** Restoring creates a new revision. It never resurrects an old transaction confirmation. */
export function restoreDraft(current: StrategyDraft, previous: StrategyDraft, context: { owner: string; expectedRevision: number; now: string }) {
  const before = draftSchema.parse(current), saved = draftSchema.parse(previous)
  scope(before, context.owner, context.expectedRevision)
  if (saved.id !== before.id || saved.owner !== before.owner || saved.kind !== before.kind || saved.revision >= before.revision) throw new DraftConflict('not an earlier revision of this draft')
  if (canonical(saved.templatePin ?? null) !== canonical(before.templatePin ?? null)) throw new DraftConflict('cannot change a pinned template by restoring history')
  const draft = draftSchema.parse({ ...saved, salt: before.salt, createdAt: before.createdAt, revision: before.revision + 1, updatedAt: context.now })
  return { draft, diff: diffDrafts(before, draft), changed: true }
}

export interface ArtifactBinding { draftId: string; revision: number; contentDigest: string; manifestHash: string }
export function assertArtifactCurrent(binding: ArtifactBinding, draft: StrategyDraft, manifestHash: string) {
  if (binding.draftId !== draft.id || binding.revision !== draft.revision || binding.contentDigest !== contentDigest(draft) || binding.manifestHash !== manifestHash) {
    throw new DraftConflict('artifact or confirmation is stale; validate and review the current revision')
  }
}
