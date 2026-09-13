import { formatUnits } from 'viem'
import { draftSchema, type StrategyDraft } from './schema.ts'
import { requirementCriterionSchema, type RequirementCriterion } from './requirement-criteria.ts'
import { scaledDecimal } from './validation.ts'

export type Enforcement = 'onchain_enforced' | 'preflight_only' | 'informational' | 'unsupported'
type Assessment = { criterion: RequirementCriterion; enforcement: Enforcement; matchesDraft: boolean | null;
  interpretation: string; actual: string | null; limitation: string; evidence: 'draft-comparison' | 'mechanism-description' | 'unavailable' }
const parameterNames = { baseToken: 'Base token', quoteToken: 'Quote token', curve: 'Curve type', feeBps: 'Fixed LP fee (bps)', deadline: 'Program deadline (Unix seconds)',
  minPrice: 'Fixed CLMM lower bound', maxPrice: 'Fixed CLMM upper bound', relativeWidthBps: 'CLMM relative half-width at application (bps)', referencePrice: 'Pegged reference price', amplification: 'Pegged amplification',
  allocationBase: 'Initial virtual base allocation', allocationQuote: 'Initial virtual quote allocation', maxAmountBasePerSwap: 'Per-swap base amount cap',
  maxAmountQuotePerSwap: 'Per-swap quote amount cap', maxPostBalanceBase: 'Post-trade base inventory cap', maxPostBalanceQuote: 'Post-trade quote inventory cap' }
const relations = { equal: 'equals', 'at-most': 'at most', 'at-least': 'at least' }
const unavailable = {
  'daily-cumulative-budget': 'Guard checks each swap amount and has no daily cumulative counter; a per-swap cap cannot replace a daily budget with a per-swap cap.',
  'guaranteed-maximum-loss': 'There is no onchain mechanism that guarantees a maximum loss; monitoring or attempting to stop does not guarantee completion within a requested loss limit.',
  'automatic-rebalance': 'Builder does not automatically swap, reset a range or reallocate funds.',
  'exact-out': 'The guarded profile rejects exact-out swaps.',
  'external-price-every-swap': 'Guard does not read external prices on every swap; it checks the latest stored report and immutable envelope.',
  'guaranteed-market-price': 'Reference parameters, asset ratios and a CLMM configuration do not guarantee execution at an external market price.',
  other: 'There is no checked implementation mapping yet; clarify the request or explicitly accept the unimplemented part.',
}
const mechanisms = {
  'guard.directions': { enforcement: 'onchain_enforced' as const, interpretation: 'Guard checks the Maker buy/sell directions on every swap.', limitation: 'The accepted report decides the actual directions; the draft cannot prove that a direction is authorized.' },
  'guard.active-strategy': { enforcement: 'onchain_enforced' as const, interpretation: 'Guard allows only the Maker\'s current active strategy hash to trade.', limitation: 'A report and readback are required; a paused report for B does not necessarily disable A.' },
  'guard.standing': { enforcement: 'onchain_enforced' as const, interpretation: 'A standing report remains valid until conditions change or it is revoked; it is not renewed on a timer.', limitation: 'It requires explicit Maker consent and a schema 2 report; service downtime does not automatically expire existing authorization.' },
  'guard.revoke': { enforcement: 'onchain_enforced' as const, interpretation: 'The Maker can revoke Guard authorization with its own wallet.', limitation: 'The Maker must sign and confirm the transaction; clearing a revocation still needs a new enabled report.' },
  'policy.market-rules': { enforcement: 'informational' as const, interpretation: 'The workflow evaluates private price/volatility rules and then updates Guard authorization.', limitation: 'Private thresholds never enter the conversation. Encryption does not prove policy verification; market observation to report activation has latency and needs a trusted binding, consent and delivery.' },
  'aqua.lifecycle': { enforcement: 'preflight_only' as const, interpretation: 'Aqua ship registers the initial virtual balances and dock stops that hash.', limitation: 'Ship does not deposit funds; strategies share wallet funds. Dock does not revoke ERC20 allowance. Wallet transactions and onchain readback are required.' },
}

/** Compares explicit proposed meanings with public draft values. Classification
 * describes the intended mechanism, not evidence that it is active. Only the
 * application can join current decoded artifacts and explicit user decisions. */
export function assessRequirementCriterion(input: unknown, draftInput: StrategyDraft): Assessment {
  return compareCriterion(requirementCriterionSchema.parse(input), draftSchema.parse(draftInput))
}
function compareCriterion(c: RequirementCriterion, draft: StrategyDraft): Assessment {
  const spec = draft.spec
  if (c.type === 'unsupported') return { criterion: c, enforcement: 'unsupported', matchesDraft: false,
    interpretation: unavailable[c.topic], actual: null, limitation: unavailable[c.topic], evidence: 'unavailable' }
  if (c.type === 'mechanism') return { criterion: c, ...mechanisms[c.capabilityId], matchesDraft: null, actual: null, evidence: 'mechanism-description' }
  let actual: string | null = null, decimals: number | null = 18, unit = '', limitation = '', enforcement: Enforcement = 'onchain_enforced'
  const field = c.field
  if (field === 'baseToken' || field === 'quoteToken') { actual = spec[field]?.symbol ?? null; decimals = null }
  else if (field === 'curve') { actual = spec.model?.kind ?? null; decimals = null }
  else if (field === 'feeBps' || field === 'deadline') {
    actual = spec[field]?.toString() ?? null; decimals = 0
    if (field === 'feeBps') {
      limitation = 'Only zero LP fee is enabled. The legacy nonzero fee recipe undercounts gross input inside Guard and cannot be activated.'
      if ((spec.feeBps ?? 0) !== 0 || (c.relation !== 'at-most' && c.expected !== '0')) enforcement = 'unsupported'
    }
  }
  else if (field === 'minPrice' || field === 'maxPrice') {
    actual = spec.model?.kind === 'concentrated' ? spec.model[field] ?? null : null
    unit = ` ${spec.quoteToken?.symbol ?? 'quote'}/${spec.baseToken?.symbol ?? 'base'}`
    limitation = 'This is a fixed curve configuration, not an external market-price check on every swap; a relative template freezes a snapshot when the Maker applies it, with atomic-unit rounding.'
  } else if (field === 'relativeWidthBps') {
    actual = spec.model?.kind === 'concentrated' ? spec.model.relativeWidthBps?.toString() ?? null : null
    decimals = 0; enforcement = 'preflight_only'
    limitation = 'A trusted snapshot becomes fixed bounds when the Maker applies the template; it does not follow the market automatically and the fixed range must be reviewed again.'
  } else if (field === 'referencePrice' || field === 'amplification') {
    actual = spec.model?.kind === 'pegged' ? spec.model[field] ?? null : null
    limitation = 'The initial Pegged execution ratio also depends on both asset allocations; a reference price does not guarantee execution at that price.'
  } else {
    const base = ['allocationBase', 'maxAmountBasePerSwap', 'maxPostBalanceBase'].includes(field), token = base ? spec.baseToken : spec.quoteToken
    const allocation = field === 'allocationBase' || field === 'allocationQuote'
    const atomic = allocation ? draft.allocations?.[base ? 'baseAtomic' : 'quoteAtomic'] : spec.guardEnvelope?.[field]
    decimals = token?.decimals ?? 18; unit = ` ${token?.symbol ?? (base ? 'base' : 'quote')}`
    actual = atomic && token ? formatUnits(BigInt(atomic), token.decimals) : null
    if (allocation) { enforcement = 'preflight_only'; limitation = 'Initial virtual allocation is not independently reserved wallet funding; it changes after trades, and fresh balance and allowance checks are required before signing.' }
    else limitation = 'The immutable envelope and current report use the stricter cap; both input and output are bounded. This is not a daily cumulative quota, inventory floor or real-time asset-value guarantee.'
  }
  const interpretation = `${parameterNames[field]}${relations[c.relation]} ${c.expected}${unit}`
  if (decimals === null) {
    const valid = c.relation === 'equal' && (field === 'curve' ? ['xyc', 'concentrated', 'pegged'].includes(c.expected) : /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(c.expected))
    return { criterion: c, enforcement: valid ? enforcement : 'unsupported', matchesDraft: valid ? actual === null ? null : actual === c.expected : false,
      interpretation, actual, limitation: valid ? limitation : 'Tokens and curves can only be compared for equality using resolved identifiers.', evidence: valid ? 'draft-comparison' : 'unavailable' }
  }
  let matched: boolean | null = null
  try {
    const expected = scaledDecimal(c.expected, decimals)
    if (actual !== null) {
      const value = scaledDecimal(actual, decimals)
      matched = c.relation === 'equal' ? value === expected : c.relation === 'at-most' ? value <= expected : value >= expected
    }
  } catch {
    return { criterion: c, enforcement: 'unsupported', matchesDraft: false, interpretation, actual,
      limitation: 'The condition format or precision does not match this parameter; clarify it before treating it as verified.', evidence: 'unavailable' }
  }
  return { criterion: c, enforcement, matchesDraft: matched, interpretation, actual,
    limitation: actual === null ? 'This draft has no corresponding value to compare.' : limitation, evidence: 'draft-comparison' }
}

export function assessRequirementCriteria(input: StrategyDraft) {
  const draft = draftSchema.parse(input)
  return draft.requirements.map(r => ({ id: r.id, text: r.text, priority: r.priority, sourceMessageId: r.sourceMessageId,
    criteria: r.criteria?.map(c => compareCriterion(c, draft)) ?? [],
    needsInterpretation: !r.criteria?.length, userConfirmed: false as const, registrationReady: false as const }))
}
