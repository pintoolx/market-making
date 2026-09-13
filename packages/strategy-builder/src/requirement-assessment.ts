import { formatUnits } from 'viem'
import { draftSchema, type StrategyDraft } from './schema.ts'
import { requirementCriterionSchema, type RequirementCriterion } from './requirement-criteria.ts'
import { scaledDecimal } from './validation.ts'

export type Enforcement = 'onchain_enforced' | 'preflight_only' | 'informational' | 'unsupported'
type Assessment = { criterion: RequirementCriterion; enforcement: Enforcement; matchesDraft: boolean | null;
  interpretation: string; actual: string | null; limitation: string; evidence: 'draft-comparison' | 'mechanism-description' | 'unavailable' }
const parameterNames = { baseToken: '基礎幣種', quoteToken: '報價幣種', curve: '曲線種類', feeBps: '固定 LP 費率（bps）', deadline: '程式 deadline（Unix 秒）',
  minPrice: '固定 CLMM 配置下界', maxPrice: '固定 CLMM 配置上界', relativeWidthBps: '套用時 CLMM 相對半寬（bps）', referencePrice: 'Pegged 參考參數', amplification: 'Pegged 放大係數',
  allocationBase: '初始基礎幣虛擬配置', allocationQuote: '初始報價幣虛擬配置', maxAmountBasePerSwap: '每筆基礎幣數量上限',
  maxAmountQuotePerSwap: '每筆報價幣數量上限', maxPostBalanceBase: '成交後基礎幣庫存上限', maxPostBalanceQuote: '成交後報價幣庫存上限' }
const relations = { equal: '等於', 'at-most': '不高於', 'at-least': '不低於' }
const unavailable = {
  'daily-cumulative-budget': '目前 Guard 檢查逐筆數量，沒有每日累計計數器；不能用單筆上限替代每日預算。',
  'guaranteed-maximum-loss': '沒有鏈上保證最大損失的機制；事件監控或嘗試停止不保證在指定損失內完成。',
  'automatic-rebalance': '目前 Builder 不會自動換幣、重設區間或重新配置。',
  'exact-out': '目前 guarded profile 拒絕 exact-out。',
  'external-price-every-swap': 'Guard 不會每筆讀取外部行情；它只檢查最近保存的 report 與不可變 envelope。',
  'guaranteed-market-price': '參考參數、資產比例或 CLMM 配置不保證按某個外部價格成交。',
  other: '尚無可核對的實作對應；需要繼續釐清或明確接受未實現的部分。',
}
const mechanisms = {
  'guard.directions': { enforcement: 'onchain_enforced' as const, interpretation: 'Guard 在每筆交換檢查授權中的 Maker 買賣方向。', limitation: '實際允許方向由已接受的 report 決定；目前草稿不能證明特定方向已授權。' },
  'guard.active-strategy': { enforcement: 'onchain_enforced' as const, interpretation: 'Guard 每個 Maker 只允許目前 active hash 成交。', limitation: '需要實際 report 與 readback；對 B 送出 paused report 不一定會停用 A。' },
  'guard.standing': { enforcement: 'onchain_enforced' as const, interpretation: 'Standing report 直到條件變更或撤銷，不定期續 TTL。', limitation: '需明確 Maker 同意及 schema 2 report；服務離線不會讓既有授權自動到期。' },
  'guard.revoke': { enforcement: 'onchain_enforced' as const, interpretation: 'Maker 可以用自己的錢包撤銷 Guard 授權。', limitation: '必須由 Maker 簽署並確認交易；解除撤銷後仍需新的 enabled report。' },
  'policy.market-rules': { enforcement: 'informational' as const, interpretation: '工作流程依序評估私密價格／波動規則，再更新 Guard 授權。', limitation: '私密門檻不進對話。加密不代表政策已驗證；行情到 report 生效有延遲，需可信 binding、有效 consent 及 delivery。' },
  'aqua.lifecycle': { enforcement: 'preflight_only' as const, interpretation: 'Aqua ship 登錄初始虛擬配置，dock 停止該 hash。', limitation: 'Ship 不會入金；多個策略共用錢包資金。Dock 不會撤銷 ERC20 allowance。需錢包交易與鏈上 readback。' },
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
  else if (field === 'feeBps' || field === 'deadline') { actual = spec[field]?.toString() ?? null; decimals = 0 }
  else if (field === 'minPrice' || field === 'maxPrice') {
    actual = spec.model?.kind === 'concentrated' ? spec.model[field] ?? null : null
    unit = ` ${spec.quoteToken?.symbol ?? 'quote'}/${spec.baseToken?.symbol ?? 'base'}`
    limitation = '這是固定曲線配置，並非每筆外部市場價格檢查；相對模板需在 Maker 套用時固定 snapshot，原子量仍有捨入。'
  } else if (field === 'relativeWidthBps') {
    actual = spec.model?.kind === 'concentrated' ? spec.model.relativeWidthBps?.toString() ?? null : null
    decimals = 0; enforcement = 'preflight_only'
    limitation = 'Maker 套用時依可信 snapshot 換成固定上下界，不會自動跟隨市場；套用後需以固定範圍重新確認。'
  } else if (field === 'referencePrice' || field === 'amplification') {
    actual = spec.model?.kind === 'pegged' ? spec.model[field] ?? null : null
    limitation = 'Pegged 初始成交比例也受兩邊資產配置影響；參考參數不保證按該價格成交。'
  } else {
    const base = ['allocationBase', 'maxAmountBasePerSwap', 'maxPostBalanceBase'].includes(field), token = base ? spec.baseToken : spec.quoteToken
    const allocation = field === 'allocationBase' || field === 'allocationQuote'
    const atomic = allocation ? draft.allocations?.[base ? 'baseAtomic' : 'quoteAtomic'] : spec.guardEnvelope?.[field]
    decimals = token?.decimals ?? 18; unit = ` ${token?.symbol ?? (base ? 'base' : 'quote')}`
    actual = atomic && token ? formatUnits(BigInt(atomic), token.decimals) : null
    if (allocation) { enforcement = 'preflight_only'; limitation = '初始虛擬配置不代表獨立保留的錢包資金；成交後會變更，簽名前需要即時餘額與 allowance 檢查。' }
    else limitation = '不可變 envelope 與當前 report 取較嚴格的上限；輸入與輸出都受限。這不是每日累計額度、庫存底線或即時資產價值保證。'
  }
  const interpretation = `${parameterNames[field]}${relations[c.relation]} ${c.expected}${unit}`
  if (decimals === null) {
    const valid = c.relation === 'equal' && (field === 'curve' ? ['xyc', 'concentrated', 'pegged'].includes(c.expected) : /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(c.expected))
    return { criterion: c, enforcement: valid ? enforcement : 'unsupported', matchesDraft: valid ? actual === null ? null : actual === c.expected : false,
      interpretation, actual, limitation: valid ? limitation : '幣種與曲線只能用已解析的識別值作等值比較。', evidence: valid ? 'draft-comparison' : 'unavailable' }
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
      limitation: '條件的數值格式或精度不符合此參數；請繼續釐清，不可把它視為已驗證。', evidence: 'unavailable' }
  }
  if (field === 'feeBps' && spec.feeBps !== undefined && spec.feeBps !== 0) return { criterion: c, enforcement: 'unsupported', matchesDraft: matched,
    interpretation, actual, limitation: '非零 LP 費率尚未通過這個 Guard profile 的組合驗證；草稿數值相符不代表可執行。', evidence: 'unavailable' }
  return { criterion: c, enforcement, matchesDraft: matched, interpretation, actual,
    limitation: actual === null ? '此草稿尚無可比較的對應值。' : limitation, evidence: 'draft-comparison' }
}

export function assessRequirementCriteria(input: StrategyDraft) {
  const draft = draftSchema.parse(input)
  return draft.requirements.map(r => ({ id: r.id, text: r.text, priority: r.priority, sourceMessageId: r.sourceMessageId,
    criteria: r.criteria?.map(c => compareCriterion(c, draft)) ?? [],
    needsInterpretation: !r.criteria?.length, userConfirmed: false as const, registrationReady: false as const }))
}
