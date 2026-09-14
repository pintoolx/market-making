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
    sourceImplemented: evidence('unverified', 'Source not verified'), sdkEncodable: evidence('unverified', 'Encoding not verified'),
    runtimeVerified: evidence('unverified', 'Requires recipe execution evidence on the target deployment; local tests do not establish testnet verification'),
    compositionTested: evidence('unverified', 'Guard composition verification required'), productEnabled: evidence('blocked', 'Not integrated into Builder'),
    routingCompatible: evidence('unverified', 'Not integrated with an aggregator or resolver; a successful local taker does not establish routing inclusion'), ...d }
}
const source = (file: string) => evidence('verified', 'Pinned source version verified', swapvm + file)
const sdk = evidence('verified', 'Executor uses pinned SDK 0.4.4 and golden encoding', 'contracts/aqua-executor/src/compile.ts')
const recipeTests = evidence('verified', 'Local upstream router, Guard V2 and mock tokens; both directions, caps, revocation and rejection',
  'contracts/aqua-executor/test/guard-v2-recipes.test.ts', 'contracts/aqua-executor/test/concentrated.test.ts')
const coreEnabled = evidence('verified', 'Builder core supports validation and compilation; wallet operations still require manifest, binding and simulation checks')

const definitions: Capability[] = [
  ...(['xyc', 'concentrated', 'pegged'] as const).map(kind => define({
    id: `curve.${kind}`, label: { xyc: 'Constant product', concentrated: 'Fixed-range CLMM', pegged: 'Pegged AMM' }[kind], layer: 'swapvm',
    description: { xyc: 'Quotes using a constant-product curve over actual inventory.', concentrated: 'Concentrates liquidity between fixed price bounds; does not automatically track the market.', pegged: 'Uses a pegged curve with a fixed reference/rate and amplification; does not guarantee an external price peg.' }[kind],
    keywords: { xyc: ['xyc', 'constant', 'full-range', 'market-making'], concentrated: ['clmm', 'range', 'concentrated', 'range'], pegged: ['pegged', 'pegged', 'stable', 'reference price'] }[kind],
    opcodes: { xyc: [17], concentrated: [18, 17], pegged: [31] }[kind],
    parameters: kind === 'xyc' ? [] : kind === 'concentrated'
      ? [{ name: 'minPrice', unit: 'quote/base', constraint: 'positive; below maxPrice' }, { name: 'maxPrice', unit: 'quote/base', constraint: 'positive; fixed at review' }]
      : [{ name: 'referencePrice', unit: 'quote/base', constraint: 'positive; rates normalized exactly' }, { name: 'amplification', unit: 'human decimal', constraint: '0–5000; encoded at 1e27' }],
    prerequisites: ['two supported ERC20 tokens', 'positive allocations', 'Guard V2'],
    sideEffects: ['maker inventory changes on swap'], recipes: [`guarded-${kind}-v2`],
    sourceImplemented: source(`instructions/${kind === 'xyc' ? 'XYCSwap' : kind === 'concentrated' ? 'XYCConcentrate' : 'PeggedSwap'}.sol`),
    sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled,
  })),
  define({ id: 'modifier.deadline', label: 'Strategy deadline', layer: 'swapvm', description: 'Rejects swaps after the program deadline, independently of report expiry.',
    opcodes: [13], keywords: ['deadline', 'deadline', 'expiry'], parameters: [{ name: 'deadline', unit: 'Unix seconds', constraint: 'positive uint40' }],
    recipes: RECIPES, sourceImplemented: source('instructions/Controls.sol'), sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled }),
  define({ id: 'modifier.salt', label: 'Immutable strategy identity', layer: 'swapvm', description: 'Each instance has a fixed salt; docked hashes are not reused.',
    opcodes: [20], recipes: RECIPES, parameters: [{ name: 'salt', unit: 'uint64 decimal string', constraint: 'server-generated once per instance' }],
    sourceImplemented: source('instructions/Controls.sol'), sdkEncodable: sdk, compositionTested: recipeTests, productEnabled: coreEnabled }),
  define({ id: 'fee.lp-input', label: 'Fixed LP input fee', layer: 'swapvm', description: 'Charges a fixed LP fee on swap input, distinct from protocol fees.',
    keywords: ['fee', 'trading fee', 'fee'], opcodes: [21], parameters: [{ name: 'feeBps', unit: 'bps', constraint: '0–9999; ABI scale 1e9' }],
    sourceImplemented: source('instructions/Fee.sol'), sdkEncodable: sdk,
    compositionTested: evidence('blocked', 'The legacy fee-before-Guard recipe undercounts gross input and inventory; regression coverage reproduces it on all three curves', 'contracts/aqua-executor/test/builder-compile.test.ts'),
    productEnabled: evidence('blocked', 'Only zero LP fee is enabled. A new verified fee-aware Guard composition is required; never silently replace a requested fee with zero') }),
  define({ id: 'modifier.decay', label: 'Decay', layer: 'swapvm', description: 'Decays virtual inventory offsets based on the last swap time; does not automatically rebalance.',
    keywords: ['decay', 'decay', 'mev'], opcodes: [19], parameters: [{ name: 'periodSeconds', unit: 'seconds', constraint: 'uint16; no backward jumps' }],
    sourceImplemented: source('instructions/Decay.sol'), sdkEncodable: sdk,
    productEnabled: evidence('blocked', 'Quote/swap state, actual Guard inventory and curve composition remain unverified') }),
  define({ id: 'access.taker-token', label: 'Taker token holdings gate', layer: 'swapvm', description: 'Restricts swaps by taker ERC20 balance or share of supply.',
    keywords: ['allowlist', 'token holdings', 'taker', 'access'], opcodes: [14, 15, 16], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', 'Caller context, Guard composition and distribution paths require verification') }),
  define({ id: 'access.origin-token', label: 'Transaction-origin token holdings gate', layer: 'swapvm', description: 'Checks tx.origin; differs from taker gating or a general address allowlist.',
    keywords: ['origin', 'token holdings'], opcodes: [33], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', 'Aggregator and smart-wallet tx.origin semantics require verification') }),
  define({ id: 'control.branch', label: 'Native conditional branch', layer: 'swapvm', description: 'Allows verified recipe control flow only; arbitrary jumps are rejected.',
    opcodes: [10, 11, 12], sourceImplemented: source('instructions/Controls.sol'),
    productEnabled: evidence('blocked', 'Only straight-line guarded recipes are supported; unknown branches or gate bypasses are rejected') }),
  define({ id: 'fee.protocol', label: 'Protocol fee', layer: 'swapvm', description: 'Separate from LP input fees; disabled by default in this product.',
    opcodes: [27, 28, 29, 30], sourceImplemented: source('instructions/Fee.sol'), productEnabled: evidence('blocked', 'Outside current product scope; must not be substituted for LP fees') }),
  ...(['directions', 'per-swap', 'inventory', 'active-strategy', 'standing', 'revoke'] as const).map(kind => define({
    id: `guard.${kind}`, label: { directions: 'Maker trading directions', 'per-swap': 'Per-swap amount limits', inventory: 'Post-swap inventory limits', 'active-strategy': 'Single active strategy', standing: 'Standing authorization', revoke: 'Persistent Maker revocation' }[kind],
    layer: 'guard', description: { directions: 'Buy and sell use the Maker perspective; report bits use the taker perspective.', 'per-swap': 'Limits atomic token amounts per swap, not daily cumulative volume.', inventory: 'Checks actual Aqua inventory against post-swap ceilings; does not guarantee inventory floors or a live USD ratio.', 'active-strategy': 'One active hash per Maker: enabling B replaces A; pausing B does not necessarily disable A.', standing: 'Remains valid until changed or revoked; service downtime does not cause automatic expiry.', revoke: 'Persistent revocation by the Maker wallet; clearing it still requires a new enabled report.' }[kind],
    keywords: [kind, 'guard', 'limits', 'risk controls'], opcodes: [32], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'Standing-v2 contract verified', 'contracts/aqua-executor/contracts/AquaGuardV2.sol'),
    sdkEncodable: evidence('verified', 'Pinned opcode 32 with target/envelope; not an opcode in the regular SDK builder', 'contracts/aqua-executor/src/guard.ts'),
    compositionTested: recipeTests, productEnabled: coreEnabled,
  })),
  define({ id: 'policy.market-rules', label: 'Private market conditions', layer: 'workflow', description: 'Price and volatility conditions, priority and fallback determine directions, per-swap limits or pauses. CRE evaluates conditions; Guard does not read oracles directly.',
    keywords: ['volatility', 'price conditions', 'pause', 'volatility', 'policy'], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'first matching rule wins; no match pauses', 'workflow/src/types.ts', 'workflow/src/intersect.ts'),
    productEnabled: evidence('verified', 'Separate encrypted editor, signed Provider version and Maker consent are connected to the opt-in local CRE worker. Actual report acceptance requires configured delivery and chain evidence; private rules never pass through the model',
      'packages/builder-service/src/workflow-input.ts', 'orchestrator/src/builder-cre-bridge.mjs') }),
  define({ id: 'policy.event-updates', label: 'Event-driven report updates', layer: 'workflow',
    description: 'A resident worker evaluates selected sources and updates standing authorization only when effective terms change. No LLM runs in the execution loop.',
    keywords: ['event', 'automatic', 'updates', 'standing'], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'Durable event inbox, Maker consent, nonce allocation and receipt reconciliation', 'packages/builder-service/src/event-delivery.ts'),
    productEnabled: evidence('verified', 'Requires operator-enabled worker and broadcaster plus Maker signed consent; a prepared subscription does not prove accepted authorization') }),
  define({ id: 'policy.outage-pause', label: 'Consented outage pause and recovery', layer: 'workflow',
    description: 'Maker consent names monitored sources and freshness limits. Failure requests a zero-direction report; recovery reevaluates the still-selected strategy. Chain or worker outages can prevent pause delivery.',
    keywords: ['outage', 'pause', 'recovery', 'stale', 'monitoring'], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'Signed outage policy, persistent transitions and a price-independent reduction to zero authority', 'packages/builder-service/src/outage-policy.ts', 'workflow/market-maker-auth/workflow.ts'),
    productEnabled: evidence('verified', 'Requires an explicit new Maker consent and configured sources; older consents are never expanded automatically') }),
  define({ id: 'aqua.lifecycle', label: 'Aqua registration and docking', layer: 'aqua', description: 'Ship records virtual balances while assets remain with the Maker; dock does not revoke allowances.',
    keywords: ['registration', 'cancel', 'funds', 'ship', 'dock'], recipes: RECIPES,
    sourceImplemented: evidence('verified', 'Pinned Aqua ABI', `https://github.com/1inch/aqua/blob/${AQUA_COMMIT}/src/interfaces/IAqua.sol`),
    compositionTested: recipeTests, productEnabled: coreEnabled }),
]

/** Copies prevent model/tool consumers mutating the trusted catalog. Filtering never turns a blocked capability on. */
export function getCapabilities(query: { ids?: readonly string[]; text?: string; layer?: Capability['layer'] } = {}): Capability[] {
  const terms = query.text?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
  return structuredClone(definitions.filter(c => (!query.ids || query.ids.includes(c.id)) && (!query.layer || c.layer === query.layer))
    .map(c => ({ c, score: terms.reduce((n, term) => n + Number([c.id, c.label, c.description, ...c.keywords].join(' ').toLowerCase().includes(term)), 0) }))
    .filter(({ score }) => !terms.length || score > 0).sort((a, b) => b.score - a.score).map(({ c }) => c))
}
