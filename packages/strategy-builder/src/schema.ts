import { z } from 'zod'

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v), 'zero address').transform(v => v.toLowerCase() as `0x${string}`)
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`)
export const atomicSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < 1n << 256n, 'exceeds uint256')
export const positiveAtomicSchema = atomicSchema.refine(v => BigInt(v) > 0n, 'must be positive')
export const capSchema = positiveAtomicSchema.refine(v => BigInt(v) < 1n << 128n, 'exceeds uint128')
export const decimalSchema = z.string().regex(/^(0|[1-9][0-9]{0,35})(\.[0-9]{1,18})?$/)
export const positiveDecimalSchema = decimalSchema.refine(v => /[1-9]/.test(v), 'must be positive')
export const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const tokenSchema = z.object({
  address: addressSchema, symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(36),
}).strict()
export const snapshotSchema = z.object({
  source: z.string().min(1).max(200), observedAt: z.string().datetime(),
  baseToken: addressSchema, quoteToken: addressSchema, price: positiveDecimalSchema,
}).strict()
export const curveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('xyc') }).strict(),
  z.object({ kind: z.literal('concentrated'), minPrice: positiveDecimalSchema.optional(), maxPrice: positiveDecimalSchema.optional(),
    // A template may request a relative range. A Maker must freeze it to absolute bounds before compiling.
    relativeWidthBps: z.number().int().min(1).max(9999).optional(), snapshot: snapshotSchema.optional() }).strict(),
  z.object({ kind: z.literal('pegged'), referencePrice: positiveDecimalSchema.optional(), amplification: decimalSchema.optional() }).strict(),
])
export const guardEnvelopeSchema = z.object({
  maxAmountBasePerSwap: capSchema, maxAmountQuotePerSwap: capSchema,
  maxPostBalanceBase: capSchema, maxPostBalanceQuote: capSchema,
}).strict()
export const modifierSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decay'), periodSeconds: z.number().int().min(1).max(65535) }).strict(),
  z.object({ kind: z.literal('taker-token-balance'), token: addressSchema, minimumAtomic: positiveAtomicSchema }).strict(),
  z.object({ kind: z.literal('origin-token-balance'), token: addressSchema }).strict(),
])

/** Public intent only. Private policy rules/ciphertexts never enter a draft or a model patch. */
export const specSchema = z.object({
  title: z.string().min(1).max(120), profileId: idSchema,
  baseToken: tokenSchema.optional(), quoteToken: tokenSchema.optional(),
  model: curveSchema.optional(), feeBps: z.number().int().min(0).max(9999).optional(),
  deadline: z.number().int().min(1).max(2 ** 40 - 1).optional(),
  modifiers: z.array(modifierSchema).max(8).default([]),
  // A conversation can confirm one bound at a time; execution requires the complete schema.
  guardEnvelope: guardEnvelopeSchema.partial().optional(),
}).strict()
export const allocationSchema = z.object({ baseAtomic: positiveAtomicSchema, quoteAtomic: positiveAtomicSchema }).strict()
export const requirementInputSchema = z.object({
  id: idSchema, text: z.string().min(1).max(1200), priority: z.enum(['must', 'prefer']),
  sourceMessageId: idSchema, capabilityIds: z.array(idSchema).max(12),
}).strict()
export const requirementSchema = requirementInputSchema.extend({
  // Set by a separate authenticated user action, never by an LLM patch.
  userAcceptedAlternative: z.boolean().default(false),
}).strict()

export const draftSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, owner: z.string().min(1).max(200), revision: revisionSchema,
  kind: z.enum(['template', 'maker']), maker: addressSchema.optional(), allocations: allocationSchema.partial().optional(),
  templatePin: z.object({ templateId: idSchema, version: revisionSchema, digest: hashSchema }).strict().optional(),
  spec: specSchema, requirements: z.array(requirementSchema).max(100),
  salt: atomicSchema.refine(v => BigInt(v) < 1n << 64n, 'exceeds uint64'),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict()

/** Model parameters merge within the same curve; changing curve replaces its parameters. Modifier lists replace explicitly. */
export const patchSchema = z.object({
  // Defaults belong to new documents, never patches: Zod 4 materializes nested
  // defaults even under partial(), which would erase modifiers on a title edit.
  spec: specSchema.omit({ modifiers: true }).partial().extend({ modifiers: z.array(modifierSchema).max(8).optional() }).strict().optional(),
  maker: addressSchema.optional(), allocations: allocationSchema.partial().optional(),
  upsertRequirements: z.array(requirementInputSchema).max(100).optional(),
  removeRequirementIds: z.array(idSchema).max(100).optional(),
}).strict()

export type StrategySpec = z.infer<typeof specSchema>
export type StrategyDraft = z.infer<typeof draftSchema>
export type DraftPatch = z.infer<typeof patchSchema>
export type Requirement = z.infer<typeof requirementSchema>
export type GuardEnvelope = z.infer<typeof guardEnvelopeSchema>
export type Token = z.infer<typeof tokenSchema>
