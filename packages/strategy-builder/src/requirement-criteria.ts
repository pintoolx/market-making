import { z } from 'zod'

/** Public, reviewable interpretations of prose. These are model proposals, never
 * user confirmations or private policy conditions. Existing signed versions omit them. */
export const reviewParameterFields = ['baseToken', 'quoteToken', 'curve', 'feeBps', 'deadline',
  'minPrice', 'maxPrice', 'relativeWidthBps', 'referencePrice', 'amplification', 'allocationBase', 'allocationQuote',
  'maxAmountBasePerSwap', 'maxAmountQuotePerSwap', 'maxPostBalanceBase', 'maxPostBalanceQuote'] as const
export const requirementCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('parameter'), field: z.enum(reviewParameterFields),
    relation: z.enum(['equal', 'at-most', 'at-least']), expected: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal('mechanism'), capabilityId: z.enum(['guard.directions', 'guard.active-strategy', 'guard.standing',
    'guard.revoke', 'policy.market-rules', 'aqua.lifecycle']) }).strict(),
  z.object({ type: z.literal('unsupported'), topic: z.enum(['daily-cumulative-budget', 'guaranteed-maximum-loss',
    'automatic-rebalance', 'exact-out', 'external-price-every-swap', 'guaranteed-market-price', 'other']) }).strict(),
])
export const requirementCriteriaSchema = z.array(requirementCriterionSchema).min(1).max(12)
export type RequirementCriterion = z.infer<typeof requirementCriterionSchema>
export const requirementDecisionSchema = z.object({ requirementId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/),
  decision: z.enum(['confirm', 'accept-limitation']) }).strict()
export const requirementDecisionsSchema = z.array(requirementDecisionSchema).max(100)
export type RequirementDecision = z.infer<typeof requirementDecisionSchema>
