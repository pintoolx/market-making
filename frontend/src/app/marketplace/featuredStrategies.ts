import { AQUA_TEMPLATES } from './aquaTemplates';
import { ADAPTIVE_PROFILE_IDS } from './mandatePresentation';
import type { Listing } from './publishedStore';

export const FEATURED: Listing[] = [
  {
    id: 'featured-adaptive-market-maker',
    name: 'Adaptive Market Maker',
    summary: 'Adapts between tighter and defensive WETH / USDC execution profiles as market conditions and your private mandate change.',
    template: AQUA_TEMPLATES[1],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
    executionProfileIds: [...ADAPTIVE_PROFILE_IDS],
  },
  {
    id: 'featured-adaptive-range',
    name: 'Adaptive Range',
    summary: 'Concentrates WETH / USDC liquidity around a private reference range and recenters when conditions change.',
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
    summary: 'Adjusts WETH / USDC quoting to move inventory back toward the Maker’s target allocation.',
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
