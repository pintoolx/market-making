import { tool } from 'ai'
import { z } from 'zod'
import type { ScenarioInput } from 'aqua-executor/builder-preview'
import { DraftConflict, draftSchema, digestJson, getCapabilities, patchSchema, scaledDecimal, validateStrategy,
  assessRequirements, assessRequirementCriteria, type StrategyDraft, type DeploymentProfile, type DraftPatch } from '@pintool/strategy-builder'
import { requirementCriteriaSchema } from '@pintool/strategy-builder'

export interface DesignRepository {
  read(): Promise<StrategyDraft>
  patch(requestId: string, expectedRevision: number, patch: DraftPatch): Promise<{ draft: StrategyDraft; diff: unknown; changed: boolean }>
  restore(requestId: string, expectedRevision: number, revision: number): Promise<{ draft: StrategyDraft; diff: unknown; changed: boolean }>
  history(): Promise<unknown>
  compile?(requestId: string, expectedRevision: number): Promise<unknown>
  compilations?(): Promise<unknown>
  simulate?(requestId: string, expectedRevision: number, artifactId: string): Promise<unknown>
  simulations?(): Promise<unknown>
  preview?(requestId: string, expectedRevision: number, options: ScenarioInput): Promise<unknown>
  previews?(): Promise<unknown>
  inventory?(expectedRevision: number): Promise<unknown>
  templateContext?(expectedRevision: number): Promise<unknown>
  registrationPlan?(requestId: string, expectedRevision: number, artifactId: string): Promise<unknown>
  cancellationPlan?(requestId: string, expectedRevision: number, artifactId: string): Promise<unknown>
}
const paths = ['title', 'baseToken', 'quoteToken', 'curve', 'minPrice', 'maxPrice', 'relativeWidthBps', 'referencePrice', 'amplification', 'feeBps', 'deadline',
  'allocationBase', 'allocationQuote', 'maxAmountBasePerSwap', 'maxAmountQuotePerSwap', 'maxPostBalanceBase', 'maxPostBalanceQuote'] as const

/** Simple strict model schema: no arbitrary JSON, addresses, owner, revision writes, approvals or private rules. */
export const designEditSchema = z.object({
  expectedRevision: z.number().int(), operation: z.enum(['patch', 'restore']), restoreRevision: z.number().int().nullable(),
  edits: z.array(z.object({ field: z.enum(paths), value: z.string().max(120) }).strict()).max(24),
  requirements: z.array(z.object({ id: z.string().nullable(), text: z.string().max(1200), priority: z.enum(['must','prefer']), capabilityIds: z.array(z.string()).max(12),
    criteria: requirementCriteriaSchema.nullable().optional() }).strict()).max(20),
}).strict()
export const visibleDraft = (input: StrategyDraft) => {
  const draft = draftSchema.parse(input)
  return { id: draft.id, revision: draft.revision, kind: draft.kind, maker: draft.maker, allocations: draft.allocations,
    spec: draft.spec, requirements: draft.requirements, templatePin: draft.templatePin }
}

/** Exact allowlisted identities, with explicit aliases only for the profile's own chain. */
export function resolveProfileToken(query: string, profile: DeploymentProfile) {
  let identity = query.trim().toLowerCase()
  if (profile.chainId === 11155111) {
    identity = identity.replace(/^(?:ethereum )?sepolia\s+/, '').replace(/\s+(?:on )?(?:ethereum )?sepolia$/, '')
  }
  return profile.tokens.find(t => t.symbol.toLowerCase() === identity || t.address.toLowerCase() === identity) ?? null
}

export function editToPatch(input: z.infer<typeof designEditSchema>, draft: StrategyDraft, profile: DeploymentProfile, sourceMessageId: string): DraftPatch {
  const spec: Record<string, unknown> = {}, model: Record<string, unknown> = { ...draft.spec.model }, caps: Record<string, unknown> = { ...draft.spec.guardEnvelope }
  const allocations: Record<string, unknown> = { ...draft.allocations }, seen = new Set<string>()
  let modelChanged = false, capsChanged = false, allocationsChanged = false
  const integer = (v: string) => { if (!/^(0|[1-9]\d{0,14})$/.test(v)) throw new Error('use-integer-units'); return Number(v) }
  const pair = { baseToken: draft.spec.baseToken, quoteToken: draft.spec.quoteToken }
  const curve = input.edits.find(e => e.field === 'curve')?.value
  if (curve !== undefined) {
    if (!['xyc','concentrated','pegged'].includes(curve)) throw new Error('unsupported-curve')
    if (model.kind !== curve) for (const key of Object.keys(model)) delete model[key]
    model.kind = curve; modelChanged = true
  }
  if (input.edits.some(e => e.field === 'relativeWidthBps') && input.edits.some(e => e.field === 'minPrice' || e.field === 'maxPrice')) throw new Error('choose-fixed-or-relative-range')
  // Resolve pair edits before any human-to-atomic amount conversion, independent of edit ordering.
  for (const e of input.edits) if (e.field === 'baseToken' || e.field === 'quoteToken') {
    const token = resolveProfileToken(e.value, profile)
    if (!token) throw new Error('unsupported-token')
    if (pair[e.field] && pair[e.field]!.address !== token.address && (draft.allocations || draft.spec.guardEnvelope)) throw new Error('pair-change-requires-new-draft')
    pair[e.field] = token; spec[e.field] = token
  }
  for (const { field, value } of input.edits) {
    if (seen.has(field)) throw new Error('duplicate-edit-field')
    seen.add(field)
    if (field === 'title') spec.title = value
    else if (field === 'baseToken' || field === 'quoteToken') continue
    else if (field === 'curve') continue
    else if (['minPrice','maxPrice','relativeWidthBps','referencePrice','amplification'].includes(field)) {
      if (!model.kind) throw new Error('choose-curve-before-parameters')
      model[field] = field === 'relativeWidthBps' ? integer(value) : value; modelChanged = true
      if (field === 'relativeWidthBps') { delete model.minPrice; delete model.maxPrice; delete model.snapshot }
      else if (field === 'minPrice' || field === 'maxPrice') delete model.relativeWidthBps
    } else if (field === 'feeBps' || field === 'deadline') spec[field] = integer(value)
    else {
      const base = ['allocationBase','maxAmountBasePerSwap','maxPostBalanceBase'].includes(field), token = base ? pair.baseToken : pair.quoteToken
      if (!token) throw new Error('resolve-pair-before-amounts')
      const atomic = scaledDecimal(value, token.decimals).toString()
      if (field === 'allocationBase' || field === 'allocationQuote') { allocations[base ? 'baseAtomic' : 'quoteAtomic'] = atomic; allocationsChanged = true }
      else { caps[field] = atomic; capsChanged = true }
    }
  }
  if (modelChanged) spec.model = model
  if (capsChanged) spec.guardEnvelope = caps
  if (allocationsChanged && draft.kind === 'template') throw new Error('maker-allocation-not-template')
  const knownRequirements = new Set(draft.requirements.map(r => r.id))
  const upsertRequirements = input.requirements.map((r, i) => {
    if (r.id && !knownRequirements.has(r.id)) throw new Error('unknown-requirement-id')
    if (r.capabilityIds.some(id => !getCapabilities({ ids: [id] }).length)) throw new Error('unknown-capability-id')
    return { ...r, id: r.id ?? `req-${sourceMessageId}-${i}`, sourceMessageId, ...(r.criteria ? { criteria: r.criteria } : {}) }
  })
  return patchSchema.parse({ ...(Object.keys(spec).length ? { spec } : {}), ...(allocationsChanged ? { allocations } : {}),
    ...(upsertRequirements.length ? { upsertRequirements } : {}) })
}

/** All closures receive an already-scoped repository, never a Pool, session token, signer or environment. */
export function createDesignTools(context: { repository: DesignRepository; profile: DeploymentProfile; turnId: string; sourceMessageId: string; nowSec: number }) {
  const { repository, profile } = context
  const read = async () => {
    const draft = draftSchema.parse(await repository.read())
    if (draft.spec.profileId !== profile.id) throw new Error('profile-mismatch')
    return draft
  }
  const safe = async (work: () => Promise<unknown>) => {
    try { return { ok: true as const, result: JSON.parse(JSON.stringify(await work())) as unknown } }
    catch (error) {
      const code = error instanceof z.ZodError ? 'invalid-edit-fields-or-units' : error instanceof DraftConflict ? 'revision-or-template-conflict'
        : error instanceof Error && /^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : 'tool-unavailable'
      return { ok: false as const, error: code, next: 'Inspect the current draft. Preserve other requirements; correct the request or ask a focused question.' }
    }
  }
  return {
    getCapabilities: tool({ description: 'Discover SwapVM, Guard, CRE and Aqua mechanisms, limitations and separate evidence layers. Use short mechanism keywords or null for the full inventory, not a paragraph. Fixed LP input fees are available only in the verified Guard V2 recipe; protocol and dynamic fees remain blocked.',
      strict: true, inputSchema: z.object({ query: z.string().nullable() }).strict(), execute: ({ query }) => safe(async () => {
        await read()
        return getCapabilities(query ? { text: query } : {}).map(c => ({ id: c.id, label: c.label, layer: c.layer, description: c.description,
          parameters: c.parameters, prerequisites: c.prerequisites, sideEffects: c.sideEffects, recipes: c.recipes,
          readiness: { source: c.sourceImplemented, encoding: c.sdkEncodable, runtime: c.runtimeVerified, composition: c.compositionTested,
            product: c.productEnabled, routing: c.routingCompatible } }))
      }) }),
    resolveTokens: tool({ description: 'Resolve tokens in the current deployment profile by bare symbol (e.g. WETH, USDC) or exact address. Returns the available verified identities when a query is not matched. Never invent token addresses or silently substitute a different chain.',
      strict: true, inputSchema: z.object({ queries: z.array(z.string()).max(4) }).strict(), execute: ({ queries }) => safe(async () => {
        await read()
        return { chainId: profile.chainId, availableTokens: profile.tokens,
          tokens: queries.map(query => ({ query, token: resolveProfileToken(query, profile) })) }
      }) }),
    getWalletInventory: tool({ description: 'Read this owned Maker wallet at one recent verified Sepolia block: native ETH, WETH/USDC balances, allowances to Aqua, and bounded known strategy virtual balances. No address or RPC input is accepted. Provider templates have no Maker inventory; use explicit hypothetical scenario allocations instead. ETH is not WETH. Wallet and virtual balances share funds and must not be added. Sufficient balance/allowance is not proof of uncommitted inventory, valid report or settlement readiness. This is an on-demand read; signing requires a fresh preflight.',
      strict: true, inputSchema: z.object({ expectedRevision: z.number().int().positive() }).strict(), execute: ({ expectedRevision }) => safe(async () => {
        const draft = await read()
        if (draft.kind !== 'maker') throw new Error('maker-instance-required')
        if (draft.revision !== expectedRevision) throw new Error('draft-changed')
        if (!repository.inventory) throw new Error('inventory-unavailable')
        return repository.inventory(expectedRevision)
      }) }),
    createOrPatchDraft: tool({ description: 'Edit this existing owned draft or restore a previous revision. Values are decimal strings; allocations and Guard caps use HUMAN token units, prices use quote/base, fees use bps, deadline uses Unix seconds. Unmentioned fields persist. Set curve before its parameters. Requirement IDs are null for new requirements or an existing ID when refining. This does not publish, approve, register or broadcast anything.',
      strict: true, inputSchema: designEditSchema, execute: (input, options) => safe(async () => {
        const draft = await read()
        const requestId = 'agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2)
        let result: Awaited<ReturnType<DesignRepository['patch']>>
        if (input.operation === 'restore') {
          if (input.restoreRevision === null || input.edits.length || input.requirements.length) throw new Error('invalid-restore-request')
          result = await repository.restore(requestId, input.expectedRevision, input.restoreRevision)
        } else {
          if (input.restoreRevision !== null) throw new Error('invalid-patch-request')
          result = await repository.patch(requestId, input.expectedRevision, editToPatch(input, draft, profile, context.sourceMessageId))
        }
        return { draft: visibleDraft(result.draft), diff: result.diff, changed: result.changed }
      }) }),
    validateStrategy: tool({ description: 'Run deterministic validation on the current draft. Reports missing fields and errors; passing draft validation is not publication, simulation, wallet approval or chain authorization.',
      strict: true, inputSchema: z.object({}).strict(), execute: () => safe(async () => {
        const draft = await read(), result = validateStrategy(draft, profile, context.nowSec)
        return { revision: draft.revision, readyForCompilation: draft.kind === 'maker' && result.ready, templateFieldsComplete: draft.kind === 'template' && result.ready,
          errors: result.errors, missingFields: result.missingFields, requirements: assessRequirements(draft), requirementAssessment: assessRequirementCriteria(draft) }
      }) }),
    compileStrategy: tool({ description: 'Compile and independently decode a complete owned Maker instance, storing an immutable artifact tied to this revision and deployment manifest. This performs no RPC or wallet action and does not make registration ready. Provider templates must first be instantiated by a Maker; never request Maker assets while authoring a Provider template.',
      strict: true, inputSchema: z.object({ expectedRevision: z.number().int().positive() }).strict(), execute: ({ expectedRevision }, options) => safe(async () => {
        const draft = await read()
        if (draft.kind !== 'maker') throw new Error('maker-instance-required')
        if (!repository.compile) throw new Error('preparation-unavailable')
        return repository.compile('agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2), expectedRevision)
      }) }),
    prepareRegistration: tool({ description: 'Create an unsigned wallet plan for the current Maker artifact: token approvals to Aqua followed by ship. It verifies owner, revision, artifact, profile and requirement receipt, and returns calldata plus fresh-read preconditions. It never signs, sends, reserves funds, accepts a report or claims registration readiness.',
      strict: true, inputSchema: z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().min(1).max(96) }).strict(), execute: ({ expectedRevision, artifactId }, options) => safe(async () => {
        const draft = await read()
        if (draft.kind !== 'maker') throw new Error('maker-instance-required')
        if (!repository.registrationPlan) throw new Error('registration-unavailable')
        return repository.registrationPlan('agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2), expectedRevision, artifactId)
      }) }),
    prepareCancellation: tool({ description: 'Create an unsigned wallet plan to dock the selected Maker artifact. It verifies owner, revision and strategy hash, and returns calldata plus readback preconditions. Docking is separate from allowance revocation; this tool never signs, sends or claims Guard authorization was revoked.',
      strict: true, inputSchema: z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().min(1).max(96) }).strict(), execute: ({ expectedRevision, artifactId }, options) => safe(async () => {
        const draft = await read()
        if (draft.kind !== 'maker') throw new Error('maker-instance-required')
        if (!repository.cancellationPlan) throw new Error('cancellation-unavailable')
        return repository.cancellationPlan('agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2), expectedRevision, artifactId)
      }) }),
    simulateLifecycle: tool({ description: 'Queue a background lifecycle check for an immutable artifact of this Maker draft and revision. Returns a job reference, not a successful simulation. Inspect simulations in a later turn for the current result. A fork-with-overrides result uses synthetic local funds/report authority and does not authorize or submit public-chain transactions.',
      strict: true, inputSchema: z.object({ artifactId: z.string(), expectedRevision: z.number().int().positive() }).strict(), execute: ({ artifactId, expectedRevision }, options) => safe(async () => {
        const draft = await read()
        if (draft.kind !== 'maker') throw new Error('maker-instance-required')
        if (!repository.simulate) throw new Error('simulation-unavailable')
        return repository.simulate('agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2), expectedRevision, artifactId)
      }) }),
    previewScenarios: tool({ description: 'Calculate and save integer trade scenarios for the current draft. Use short ASCII scenario names (letters, numbers, hyphens). Amounts use HUMAN token units. tokenIn is what the TAKER supplies; base input means the Maker receives base and pays quote. Each named scenario resets to the allocation; its trades are sequential. Maker allocations come only from the draft (hypotheticalAllocations must be null). A Provider template requires explicit hypothetical base/quote amounts for comparison, never a Maker wallet. This assumes an active bidirectional report equal to the public caps; it is mathematical preview, not live quote, settlement, forecast or wallet readiness.',
      strict: true, inputSchema: z.object({ expectedRevision: z.number().int().positive(),
        hypotheticalAllocations: z.object({ base: z.string().max(80), quote: z.string().max(80) }).strict().nullable(),
        scenarios: z.array(z.object({ name: z.string().max(96), trades: z.array(z.object({ tokenIn: z.enum(['base','quote']), amount: z.string().max(80) }).strict()).min(1).max(6) }).strict()).min(1).max(4),
      }).strict(), execute: (input, options) => safe(async () => {
        const draft = await read()
        if (draft.revision !== input.expectedRevision) throw new Error('draft-changed')
        if (!draft.spec.baseToken || !draft.spec.quoteToken) throw new Error('resolve-pair-before-amounts')
        if (!repository.preview) throw new Error('preview-unavailable')
        const atom = (value: string, token: 'base' | 'quote') => scaledDecimal(value, (token === 'base' ? draft.spec.baseToken! : draft.spec.quoteToken!).decimals).toString()
        return repository.preview('agent-' + digestJson({ turnId: context.turnId, toolCallId: options.toolCallId }).slice(2), input.expectedRevision, {
          hypotheticalAllocations: input.hypotheticalAllocations ? { baseAtomic: atom(input.hypotheticalAllocations.base, 'base'), quoteAtomic: atom(input.hypotheticalAllocations.quote, 'quote') } : null,
          scenarios: input.scenarios.map(s => ({ name: s.name, trades: s.trades.map(t => ({ tokenIn: t.tokenIn, amountInAtomic: atom(t.amount, t.tokenIn) })) })),
        })
      }) }),
    inspectStrategy: tool({ description: 'Read authoritative current state, revision history, compilations, previews or background simulation status. Use at the beginning of a turn and after conflicts. Old or mock simulation results cannot establish current fork verification or wallet readiness.',
      strict: true, inputSchema: z.object({ view: z.enum(['current','history','compilations','simulations','previews']) }).strict(), execute: ({ view }) => safe(async () => {
        const draft = await read()
        if (view === 'previews') return { draft: visibleDraft(draft), previews: await repository.previews?.() ?? [] }
        if (view === 'compilations') return { draft: visibleDraft(draft), compilations: await repository.compilations?.() ?? [] }
        if (view === 'simulations') return { draft: visibleDraft(draft), simulations: await repository.simulations?.() ?? [] }
        return view === 'history' ? { draft: visibleDraft(draft), history: await repository.history() } : {
          ...visibleDraft(draft), ...(draft.templatePin ? { templateContext: await repository.templateContext?.(draft.revision) ?? null } : {}),
        }
      }) }),
    exportStrategy: tool({ description: 'Export the current public draft as a portable non-executable specification. No private policy, signature or transaction is included. Executable artifact export requires the later compiler/simulation stage.',
      strict: true, inputSchema: z.object({}).strict(), execute: () => safe(async () => {
        const draft = await read()
        return { format: 'pintool-public-strategy-draft-v1', executable: false, draft: visibleDraft(draft) }
      }) }),
  }
}
