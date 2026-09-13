/** Explicit browser-only authoring subpath. Never import into a model repository,
 * conversation route, public stream or general event logger. No I/O or secrets. */
import { z } from 'zod'
import { idSchema, specSchema, type StrategySpec } from './schema.ts'
import { scaledDecimal } from './validation.ts'

const field = z.string().max(80)
export const privateRuleFormSchema = z.object({
  id: idSchema, priceMin: field, priceMax: field, volatilityBpsMin: field, volatilityBpsMax: field,
  allowMakerBuyBase: z.boolean(), allowMakerSellBase: z.boolean(), maxAmountBase: field, maxAmountQuote: field,
}).strict()
export const privatePolicyFormSchema = z.object({ rules: z.array(privateRuleFormSchema).min(1).max(8), maxBalanceBase: field, maxBalanceQuote: field }).strict()
export type PrivateRuleForm = z.infer<typeof privateRuleFormSchema>
export type PrivatePolicyForm = z.infer<typeof privatePolicyFormSchema>
export class PrivatePolicyError extends Error {
  readonly field: string
  constructor(field: string, message: string) { super(message); this.field = field }
}

/** Local wire encoder for workflow providerStrategySchema v1. Token0 is the
 * draft's base token, matching the guarded Builder compiler; do not sort it by address. */
export function encodePrivatePolicy(input: unknown, specInput: StrategySpec, strategyId: string) {
  const parsed = privatePolicyFormSchema.safeParse(input)
  if (!parsed.success) throw new PrivatePolicyError('rules', '請完整設定 1 至 8 條私密規則。')
  const form = parsed.data, spec = specSchema.parse(specInput)
  idSchema.parse(strategyId)
  if (!spec.baseToken || !spec.quoteToken || !spec.guardEnvelope) throw new PrivatePolicyError('rules', '請先完成公開交易對與 Guard 上限。')
  const base = spec.baseToken, quote = spec.quoteToken, caps = spec.guardEnvelope
  const atomic = (value: string, decimals: number, cap: string | undefined, path: string) => {
    if (!cap) throw new PrivatePolicyError(path, '請先設定對應的公開上限。')
    let n: bigint
    try { n = scaledDecimal(value, decimals) } catch { throw new PrivatePolicyError(path, '請輸入符合幣種精度的非負數量。') }
    if (n > BigInt(cap)) throw new PrivatePolicyError(path, '私密上限不能超過對應的公開 Guard 上限。')
    return String(n)
  }
  const price = (value: string, path: string) => {
    if (!value) return undefined
    try { if (scaledDecimal(value, 8) <= 0n) throw new Error('positive price required') }
    catch { throw new PrivatePolicyError(path, '價格必須大於零，最多 8 位小數。') }
    return value
  }
  const bps = (value: string, path: string) => {
    if (!value) return undefined
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new PrivatePolicyError(path, '波動門檻請輸入非負整數 bps。')
    return Number(value)
  }
  const ids = new Set<string>()
  const rules = form.rules.map((rule, index) => {
    const root = `rules.${index}`, when: { priceMin?: string; priceMax?: string; volatilityBpsMin?: number; volatilityBpsMax?: number } = {}
    if (ids.has(rule.id)) throw new PrivatePolicyError(root, '規則識別碼重複，請重新新增規則。')
    ids.add(rule.id)
    const lo = price(rule.priceMin, `${root}.priceMin`), hi = price(rule.priceMax, `${root}.priceMax`)
    const vLo = bps(rule.volatilityBpsMin, `${root}.volatilityBpsMin`), vHi = bps(rule.volatilityBpsMax, `${root}.volatilityBpsMax`)
    if (lo && hi && scaledDecimal(lo, 8) > scaledDecimal(hi, 8)) throw new PrivatePolicyError(`${root}.priceMax`, '價格上限不可小於下限。')
    if (vLo !== undefined && vHi !== undefined && vLo > vHi) throw new PrivatePolicyError(`${root}.volatilityBpsMax`, '波動上限不可小於下限。')
    if (lo !== undefined) when.priceMin = lo
    if (hi !== undefined) when.priceMax = hi
    if (vLo !== undefined) when.volatilityBpsMin = vLo
    if (vHi !== undefined) when.volatilityBpsMax = vHi
    if (!Object.keys(when).length && index !== form.rules.length - 1) throw new PrivatePolicyError(root, '無條件規則會遮住後續規則，請移到最後或加上條件。')
    return { id: rule.id, when, allowMakerBuyToken0: rule.allowMakerBuyBase, allowMakerSellToken0: rule.allowMakerSellBase,
      maxAmount0PerSwap: atomic(rule.maxAmountBase, base.decimals, caps.maxAmountBasePerSwap, `${root}.maxAmountBase`),
      maxAmount1PerSwap: atomic(rule.maxAmountQuote, quote.decimals, caps.maxAmountQuotePerSwap, `${root}.maxAmountQuote`),
      // Required by the existing wire schema. Standing Maker V3 ignores this legacy value.
      ttlSec: 600 }
  })
  const policy = { schemaVersion: 1 as const, strategyId, rules, inventory: {
    maxBalance0: atomic(form.maxBalanceBase, base.decimals, caps.maxPostBalanceBase, 'maxBalanceBase'),
    maxBalance1: atomic(form.maxBalanceQuote, quote.decimals, caps.maxPostBalanceQuote, 'maxBalanceQuote'),
  } }
  // 16-byte AEAD tag must fit the existing workflow's 4096-byte ciphertext limit.
  if (new TextEncoder().encode(JSON.stringify(policy)).length > 4080) throw new PrivatePolicyError('rules', '規則內容超過可加密長度，請減少規則或縮短數值。')
  return policy
}
