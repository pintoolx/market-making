// Categories stay as data; the UI shows them as Core / Add-ons / Capital.
export const CATEGORY_LABELS = { 'Base strategy': 'Core', 'Strategy modifier': 'Add-ons', 'Capital policy': 'Capital' } as const;

export type AquaTemplate = {
  id: string;
  name: string;
  /** SwapVM mechanism name, for people who know Aqua. */
  mechanism: string;
  /** Plain-language name of the mechanism shown on cards. */
  label: string;
  category: 'Base strategy' | 'Strategy modifier' | 'Capital policy';
  summary: string;
  privateInputs: string;
  execution: string;
  risk: string;
  prompt: string;
};

// Educational examples from AQUA-MAKER-RESEARCH.md, not deployed provider listings.
export const AQUA_TEMPLATES: AquaTemplate[] = [
  {
    id: 'xyc', name: 'Classic two-sided', mechanism: 'XYC', label: 'Constant product', category: 'Base strategy',
    summary: 'Quote both assets using a constant-product curve.',
    privateInputs: 'Fee adjustment rules and the signals used to change them.',
    execution: 'A constant-product program with explicit balances and fees.',
    risk: 'Inventory value can fall as prices move. Fees do not guarantee a profit.',
    prompt: 'Describe when to adjust fees or stop quoting both sides.',
  },
  {
    id: 'clmm', name: 'Adaptive range', mechanism: 'CLMM', label: 'Price range', category: 'Base strategy',
    summary: 'Concentrate liquidity in a price range and define when to replace it.',
    privateInputs: 'Range selection model, recentering signals and thresholds.',
    execution: 'A concentrated-liquidity program with the selected range.',
    risk: 'A position can become one-sided or stop trading outside its range.',
    prompt: 'Describe how to select the range and when to recenter it.',
  },
  {
    id: 'pegged', name: 'Stable-asset maker', mechanism: 'PeggedSwap', label: 'Stable pair', category: 'Base strategy',
    summary: 'Quote assets around a reference price with a defined spread.',
    privateInputs: 'Reference-price selection, spread rules and depeg triggers.',
    execution: 'A pegged-price program with explicit pricing parameters.',
    risk: 'A broken peg or stale reference price can leave the maker holding the weaker asset.',
    prompt: 'Describe the reference price, spread rules and depeg response.',
  },
  {
    id: 'decay', name: 'Decay maker', mechanism: 'Decay', label: 'Decay pricing', category: 'Strategy modifier',
    summary: 'Add temporary pricing adjustments after a swap that decay over time.',
    privateInputs: 'Rules for choosing the decay period and pricing adjustment.',
    execution: 'A compatible base program with decay instructions.',
    risk: 'Decay changes quoting behavior; it does not eliminate arbitrage losses.',
    prompt: 'Describe the base strategy and how to select decay parameters.',
  },
  {
    id: 'inventory', name: 'Inventory-aware maker', mechanism: 'Inventory rules', label: 'Inventory control', category: 'Strategy modifier',
    summary: 'Adapt quoting decisions to move inventory toward a target allocation.',
    privateInputs: 'Target inventory, tolerance bands and adjustment logic.',
    execution: 'A compatible program updated by an inventory-aware controller.',
    risk: 'Targets may not be reached, and adverse order flow can move inventory away from its intended allocation.',
    prompt: 'Describe the base strategy, target inventory and response to imbalance.',
  },
  {
    id: 'shared', name: 'Shared capital', mechanism: 'Virtual balances', label: 'Shared capital', category: 'Capital policy',
    summary: 'Coordinate virtual allocations across strategies using one maker wallet.',
    privateInputs: 'Allocation priorities, aggregate budgets and suspension rules.',
    execution: 'Multiple strategies with separately assigned virtual balances.',
    risk: 'Virtual balances do not reserve tokens. One fill can leave another strategy underfunded.',
    prompt: 'Describe strategy priorities and the aggregate capital limits to enforce.',
  },
];
