import { AQUA_TEMPLATES } from './aquaTemplates';
import { ADAPTIVE_PROFILE_IDS } from './mandatePresentation';
import type { Listing } from './publishedStore';

export const FEATURED: Listing[] = [
  {
    id: 'featured-adaptive-market-maker',
    name: 'Adaptive Market Maker',
    summary: 'Switches between tight and defensive WETH / USDC quoting as market conditions change, while respecting your private liquidity limits.',
    template: { ...AQUA_TEMPLATES[1], privateInputs: 'Volatility threshold used to select tight, defensive or paused mode.' },
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
    executionProfileIds: [...ADAPTIVE_PROFILE_IDS],
  },
  {
    id: 'featured-adaptive-range',
    name: 'Adaptive Range',
    summary: 'Quotes WETH / USDC inside a defined range and recenters when its confidential market condition is met.',
    template: AQUA_TEMPLATES[1],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
  },
  {
    id: 'featured-wide-range',
    name: 'Wide Range Reserve',
    summary: 'Uses a wider WETH / USDC range to remain available through larger price moves.',
    template: AQUA_TEMPLATES[1],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
  },
  {
    id: 'featured-inventory-recovery',
    name: 'Inventory Recovery',
    summary: 'Adjusts WETH / USDC quoting to move inventory back toward the maker’s target allocation.',
    template: AQUA_TEMPLATES[4],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
  },
  {
    id: 'featured-flow-decay',
    name: 'Flow Decay',
    summary: 'Temporarily changes WETH / USDC pricing after a fill, then decays toward its baseline quote.',
    template: AQUA_TEMPLATES[3],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
  },
];
