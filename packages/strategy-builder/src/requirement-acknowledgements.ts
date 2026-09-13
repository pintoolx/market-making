import { draftSchema, type StrategyDraft } from './schema.ts'
import { diffDrafts, DraftAccessDenied, DraftConflict } from './drafts.ts'
import { assessRequirementCriteria } from './requirement-assessment.ts'
import { requirementDecisionsSchema } from './requirement-criteria.ts'

/** Called only by the authenticated user-review endpoint. The model's patch schema
 * has no decision or acceptance field. The service persists a separate review receipt. */
export function acknowledgeRequirements(input: StrategyDraft, decisionsInput: unknown, context: { owner: string; expectedRevision: number; now: string }) {
  const before = draftSchema.parse(input), decisions = requirementDecisionsSchema.parse(decisionsInput)
  if (before.owner !== context.owner) throw new DraftAccessDenied('draft belongs to another user')
  if (before.revision !== context.expectedRevision) throw new DraftConflict('draft changed; reload before reviewing')
  if (decisions.length !== before.requirements.length || new Set(decisions.map(d => d.requirementId)).size !== decisions.length ||
    decisions.some(d => !before.requirements.some(r => r.id === d.requirementId))) throw new DraftConflict('every requirement needs an explicit decision')
  const rows = assessRequirementCriteria(before)
  for (const row of rows) {
    const decision = decisions.find(d => d.requirementId === row.id)!
    if (row.needsInterpretation || row.criteria.some(c => c.criterion.type === 'parameter' && (c.matchesDraft === null || c.evidence === 'unavailable')))
      throw new DraftConflict('requirement meaning or parameter needs clarification')
    if (decision.decision === 'confirm' && row.criteria.some(c => c.enforcement === 'unsupported' || c.matchesDraft === false))
      throw new DraftConflict('an unmet requirement needs explicit acceptance of the limitation')
  }
  const candidate = draftSchema.parse({ ...before, requirements: before.requirements.map(r => ({ ...r,
    userAcceptedAlternative: decisions.find(d => d.requirementId === r.id)!.decision === 'accept-limitation' })), updatedAt: context.now })
  const diff = diffDrafts(before, candidate)
  if (!diff.length) return { draft: before, diff, changed: false }
  return { draft: draftSchema.parse({ ...candidate, revision: before.revision + 1 }), diff, changed: true }
}
