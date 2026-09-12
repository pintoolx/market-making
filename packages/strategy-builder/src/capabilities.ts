export type EvidenceState = 'verified' | 'unverified' | 'blocked'
export interface Evidence { state: EvidenceState; reason: string; sources: readonly string[] }
export interface Capability {
  id: string; label: string; layer: 'swapvm' | 'guard' | 'workflow' | 'aqua'; description: string;
  keywords: readonly string[]; opcodes: readonly number[]; parameters: readonly { name: string; unit: string; constraint: string }[];
  prerequisites: readonly string[]; sideEffects: readonly string[]; recipes: readonly string[];
  sourceImplemented: Evidence; sdkEncodable: Evidence; runtimeVerified: Evidence;
  compositionTested: Evidence; productEnabled: Evidence; routingCompatible: Evidence;
}
export const SWAPVM_COMMIT = '32c687c2b73101fc26549e48fa1ff8a4d73afbac'
export const AQUA_COMMIT = '9c5c42e5840e8741fba3597c48456c9510212b66'
const swapvm = `https://github.com/1inch/swap-vm/blob/${SWAPVM_COMMIT}/src/`
const evidence = (state: EvidenceState, reason: string, ...sources: string[]): Evidence => ({ state, reason, sources })

/** Runtime table after AquaOpcodes drops its first array sentinel. Reserved slots must never compile. */
export const AQUA_OPCODES = [
  ...Array.from({ length: 10 }, () => 'reserved'),
  'jump', 'jumpIfTokenIn', 'jumpIfTokenOut', 'deadline',
  'onlyTakerTokenBalanceNonZero', 'onlyTakerTokenBalanceGte', 'onlyTakerTokenSupplyShareGte',
  'xycSwapXD', 'xycConcentrateGrowLiquidity2D', 'decayXD', 'salt', 'flatFeeAmountInXD',
  ...Array.from({ length: 5 }, () => 'reserved'),
  'protocolFeeAmountInXD', 'aquaProtocolFeeAmountInXD', 'dynamicProtocolFeeAmountInXD', 'aquaDynamicProtocolFeeAmountInXD',
  'peggedSwapGrowPriceRange2D', 'extruction', 'onlyTxOriginTokenBalanceNonZero',
] as const

const RECIPES = ['guarded-xyc-v2', 'guarded-concentrated-v2', 'guarded-pegged-v2'] as const
type Definition = Pick<Capability, 'id' | 'label' | 'layer' | 'description'> & Partial<Omit<Capability, 'id' | 'label' | 'layer' | 'description'>>
function define(d: Definition): Capability {
  return { keywords: [], opcodes: [], parameters: [], prerequisites: [], sideEffects: [], recipes: [],
    sourceImplemented: evidence('unverified', '尚未核對來源'), sdkEncodable: evidence('unverified', '尚未核對編碼'),
    runtimeVerified: evidence('unverified', '需目標部署的 recipe 執行證據；本地測試不等於 testnet 驗證'),
    compositionTested: evidence('unverified', '需要 Guard 組合驗證'), productEnabled: evidence('blocked', '尚未接入 Builder'),
    routingCompatible: evidence('unverified', '尚未接入聚合器／resolver；自家 taker 成功不代表已收錄'), ...d }
}
const source = (file: string) => evidence('verified', '已核對固定版本來源', swapvm + file)
const sdk = evidence('verified', 'executor 使用固定 SDK 0.4.4 與 golden encoding', 'contracts/aqua-executor/src/compile.ts')
const recipeTests = evidence('verified', '本地上游 router + Guard V2 + mock tokens；雙向、caps、撤銷與拒絕',
  'contracts/aqua-executor/test/guard-v2-recipes.test.ts', 'contracts/aqua-executor/test/concentrated.test.ts')
const coreEnabled = evidence('verified', 'Builder 核心可驗證／編譯；錢包仍須通過 manifest、binding 及 simulation gates')

const definitions: Capability[] = [
  ...(['xyc', 'concentrated', 'pegged'] as const).map(kind => define({
    id: `curve.${kind}`, label: { xyc: 'Constant product', concentrated: '固定區間 CLMM', pegged: 'Pegged AMM' }[kind], layer: 'swapvm',
    description: { xyc: '以實際庫存的乘積曲線報價。', concentrated: '在已固定的上下價格區間集中流動性；不自動跟價。', pegged: '依固定 reference/rate 和 amplification 使用 pegged 曲線，不保證外部價格維持錨定。' }[kind],
    keywords: { xyc: ['xyc', 'constant', '全區間', '做市'], concentrated: ['clmm', '區間', '集中', 'range'], pegged: ['pegged', '錨定', 'stable', '參考價'] }[kind],
    opcodes: { xyc: [17], concentrated: [18, 17], pegged: [31] }[kind],
    parameters: kind === 'xyc' ? [] : kind === 'concentrated'
      ? [{ name: 'minPrice', unit: 'quote/base', constraint: 'positive; below maxPrice' }, { name: 'maxPrice', unit: 'quote/base', constraint: 'positive; fixed at review' }]
      : [{ name: 'referencePrice', unit: 'quote/base', constraint: 'positive; rates normalized exactly' }, { name: 'amplification', unit: 'human decimal', constraint: '0–5000; encoded at 1e27' }],
    prerequisites: ['two supported ERC20 tokens', 'positive allocations', 'Guard V2', 'zero LP fee initially'],
    sideEffects: ['maker inventory changes on swap'], recipes: [`guarded-${kind}-v2`],
    sourceImplemented: source(`instructions/${kind === 'xyc' ? 'XYCSwap' : kind === 'concentrated' ? 'XYCConcentrate' : 'PeggedSwap'}.sol`),
    sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled,
  })),
  define({ id: 'modifier.deadline', label: '策略期限', layer: 'swapvm', description: '在 program deadline 後拒絕交易；與 report expiry 分開。',
    opcodes: [13], keywords: ['期限', 'deadline', '到期'], parameters: [{ name: 'deadline', unit: 'Unix seconds', constraint: 'positive uint40' }],
    recipes: RECIPES, sourceImplemented: source('instructions/Controls.sol'), sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled }),
  define({ id: 'modifier.salt', label: '不可變策略識別', layer: 'swapvm', description: '每個實例固定 salt；已 dock 的 hash 不重用。',
    opcodes: [20], recipes: RECIPES, parameters: [{ name: 'salt', unit: 'uint64 decimal string', constraint: 'server-generated once per instance' }],
    sourceImplemented: source('instructions/Controls.sol'), sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled }),
  define({ id: 'fee.lp-input', label: '固定 LP 輸入費', layer: 'swapvm', description: '對成交輸入收取固定 LP 費率；不是 protocol fee。',
    keywords: ['費率', '手續費', 'fee'], opcodes: [21], parameters: [{ name: 'feeBps', unit: 'bps', constraint: '0–9999; ABI scale 1e9' }],
    sourceImplemented: source('instructions/Fee.sol'), sdkEncodable: sdk,
    productEnabled: evidence('blocked', '非零費率需要完成 Guard gross/net 與實際庫存 accounting；零費率可用') }),
  define({ id: 'modifier.decay', label: 'Decay', layer: 'swapvm', description: '按上次成交時間衰減虛擬庫存偏移；不是自動 rebalance。',
    keywords: ['decay', '衰減', 'mev'], opcodes: [19], parameters: [{ name: 'periodSeconds', unit: 'seconds', constraint: 'uint16; no backward jumps' }],
    sourceImplemented: source('instructions/Decay.sol'), sdkEncodable: sdk,
    productEnabled: evidence('blocked', '待驗證 quote/swap state、Guard 實際庫存與曲線組合') }),
  define({ id: 'access.taker-token', label: 'Taker 持幣條件', layer: 'swapvm', description: '依 taker 的 ERC20 餘額或供給占比限制成交。',
    keywords: ['白名單', '持幣', 'taker', 'access'], opcodes: [14, 15, 16], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', '須驗證 caller context、Guard 組合及分發路徑') }),
  define({ id: 'access.origin-token', label: '交易 origin 持幣條件', layer: 'swapvm', description: '核對 tx.origin；不等同 taker gate 或通用地址白名單。',
    keywords: ['origin', '持幣'], opcodes: [33], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', '須核對 aggregator／smart wallet 的 tx.origin 語意') }),
  define({ id: 'control.branch', label: '原生條件分支', layer: 'swapvm', description: '只允許已核對 recipe 的控制流程，不接受任意 jump。',
    opcodes: [10, 11, 12], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', '目前僅 straight-line guarded recipes；未知分支或繞過 gate 均拒絕') }),
  define({ id: 'fee.protocol', label: 'Protocol fee', layer: 'swapvm', description: '獨立於 LP input fee；本產品預設關閉。',
    opcodes: [27, 28, 29, 30], sourceImplemented: source('instructions/Fee.sol'), productEnabled: evidence('blocked', '目前產品範圍外，不可換成 LP fee') }),
  ...(['directions', 'per-swap', 'inventory', 'active-strategy', 'standing', 'revoke'] as const).map(kind => define({
    id: `guard.${kind}`, label: { directions: 'Maker 買賣方向', 'per-swap': '逐筆數量上限', inventory: '成交後庫存上限', 'active-strategy': '單一 active strategy', standing: 'Standing 授權', revoke: 'Maker 持續撤銷' }[kind],
    layer: 'guard', description: { directions: '以 Maker 視角區分買與賣；report 的 bits 採 taker 視角。', 'per-swap': '限制每筆交換的 token 原子數量；不等於每日累計。', inventory: '讀取實際 Aqua 庫存檢查成交後上限；不保證庫存底線或即時 USD 比例。', 'active-strategy': '每 Maker 一個 active hash；enabled B 會取代 A，paused B 不必然停用 A。', standing: '直到變更或撤銷；服務離線不自動過期。', revoke: 'Maker 錢包持續撤銷；解除後仍需新的 enabled report。' }[kind],
    keywords: [kind, 'guard', '限制', '風控'], opcodes: [32], recipes: RECIPES,
    sourceImplemented: evidence('verified', '已核對 standing-v2 合約', 'contracts/aqua-executor/contracts/AquaGuardV2.sol'),
    sdkEncodable: evidence('verified', '固定 opcode 32 + target/envelope；不是 SDK regular builder 的 opcode', 'contracts/aqua-executor/src/guard.ts'),
    compositionTested: recipeTests, productEnabled: coreEnabled,
  })),
  define({ id: 'policy.market-rules', label: '私密市場條件', layer: 'workflow', description: '依價格／波動條件、優先順序與 fallback 決定方向、單筆上限或暫停。條件由 CRE 評估，Guard 不自行讀 oracle。',
    keywords: ['波動', '價格條件', '暫停', 'volatility', 'policy'], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'first matching rule wins; no match pauses', 'workflow/src/types.ts', 'workflow/src/intersect.ts'),
    productEnabled: evidence('blocked', 'Builder 私密規則編輯器及可信 binding 待接；不可透過模型傳私密規則') }),
  define({ id: 'aqua.lifecycle', label: 'Aqua 註冊與取消', layer: 'aqua', description: 'ship 登錄 virtual balance，資產仍在 Maker；dock 不撤銷 allowance。',
    keywords: ['註冊', '取消', '資金', 'ship', 'dock'], recipes: RECIPES,
    sourceImplemented: evidence('verified', '固定 Aqua ABI', `https://github.com/1inch/aqua/blob/${AQUA_COMMIT}/src/interfaces/IAqua.sol`),
    compositionTested: recipeTests, productEnabled: coreEnabled }),
]

/** Copies prevent model/tool consumers mutating the trusted catalog. Filtering never turns a blocked capability on. */
export function getCapabilities(query: { ids?: readonly string[]; text?: string; layer?: Capability['layer'] } = {}): Capability[] {
  const terms = query.text?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
  return structuredClone(definitions.filter(c => (!query.ids || query.ids.includes(c.id)) && (!query.layer || c.layer === query.layer))
    .map(c => ({ c, score: terms.reduce((n, term) => n + Number([c.id, c.label, c.description, ...c.keywords].join(' ').toLowerCase().includes(term)), 0) }))
    .filter(({ score }) => !terms.length || score > 0).sort((a, b) => b.score - a.score).map(({ c }) => c))
}
