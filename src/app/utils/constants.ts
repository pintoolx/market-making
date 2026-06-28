// Shared constants for the application

import { NodeCategory } from '../types/workflow';

// Design system constants
export const COLORS = {
  background: '#181A20',
  panelBackground: '#23243A',
  accent: '#FFD166',
  text: '#F3F3F3',
  textSecondary: '#A0A0A0',
  border: '#3A3A4A',
  success: '#4ECDC4',
  warning: '#FFD166',
  error: '#FF6B6B',
  info: '#6A4C93',
} as const;

// Spacing constants (8px grid system)
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
} as const;

// Border radius constants
export const BORDER_RADIUS = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
} as const;

// Node categories for workflow builder
export const NODE_CATEGORIES: NodeCategory[] = [
  {
    name: 'Triggers',
    color: '#FF6B6B',
    nodes: [
      { 
        id: 'price-trigger', 
        label: 'Price Trigger', 
        icon: '💹',
        category: 'Triggers',
        configSchema: {
          asset: { type: 'string', required: true },
          threshold: { type: 'number', required: true },
          condition: { type: 'select', options: ['above', 'below'] }
        }
      },
      { 
        id: 'time-trigger', 
        label: 'Time Trigger', 
        icon: '⏰',
        category: 'Triggers',
        configSchema: {
          schedule: { type: 'string', required: true },
          timezone: { type: 'string', default: 'UTC' }
        }
      },
    ],
  },
  {
    name: 'Actions',
    color: '#4ECDC4',
    nodes: [
      { 
        id: 'swap', 
        label: 'Swap', 
        icon: '🔄',
        category: 'Actions',
        configSchema: {
          fromAsset: { type: 'string', required: true },
          toAsset: { type: 'string', required: true },
          amount: { type: 'number', required: true }
        }
      },
      { 
        id: 'transfer', 
        label: 'Transfer', 
        icon: '💸',
        category: 'Actions',
        configSchema: {
          asset: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          recipient: { type: 'string', required: true }
        }
      },
    ],
  },
  {
    name: 'Logic',
    color: '#FFD166',
    nodes: [
      { 
        id: 'if', 
        label: 'If', 
        icon: '🔀',
        category: 'Logic',
        configSchema: {
          condition: { type: 'string', required: true },
          operator: { type: 'select', options: ['equals', 'greater', 'less'] }
        }
      },
      { 
        id: 'wait', 
        label: 'Wait', 
        icon: '⏳',
        category: 'Logic',
        configSchema: {
          duration: { type: 'number', required: true },
          unit: { type: 'select', options: ['seconds', 'minutes', 'hours'] }
        }
      },
    ],
  },
  {
    name: 'Notifications',
    color: '#6A4C93',
    nodes: [
      { 
        id: 'email', 
        label: 'Email', 
        icon: '📧',
        category: 'Notifications',
        configSchema: {
          recipient: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          message: { type: 'text', required: true }
        }
      },
      { 
        id: 'sms', 
        label: 'SMS', 
        icon: '📱',
        category: 'Notifications',
        configSchema: {
          phoneNumber: { type: 'string', required: true },
          message: { type: 'text', required: true }
        }
      },
    ],
  },
];

// Strategy categories for marketplace
export const STRATEGY_CATEGORIES = [
  'DeFi',
  'Trading',
  'Arbitrage',
  'Yield Farming',
  'Portfolio Management',
  'Risk Management',
] as const;

// Default filter options
export const DEFAULT_FILTER_OPTIONS = {
  categories: [],
  tags: [],
  ratingRange: [0, 5] as [number, number],
  sortBy: 'rating' as const,
};

// Page routes
export const ROUTES = {
  entry: '/',
  workflows: '/workflows',
} as const;

// Centralized token prices (editable)
// Keys should match JUPITER_TICKERS (uppercase)
export const TOKEN_PRICES: Record<string, number> = {
  SOL: 204,
  JITOSOL: 240,
  JitoSOL: 240, // alias for compatibility
  USDC: 1,
  mSOL: 220,
  bSOL: 210,
  jupSOL: 215,
  INF: 205,
  hSOL: 208,
  stSOL: 206,
};

// Estimated network fee mapping by priority (in SOL)
export const PRIORITY_ESTIMATED_NETWORK_FEE: Record<'Low' | 'Medium' | 'High', number> = {
  Low: 0.00001,
  Medium: 0.00003,
  High: 0.00005,
};

// Kamino Lending Pool options
export const KAMINO_POOL_OPTIONS = [
  { value: 'pool-a', label: 'USDC Prime', apy: 8.54 },
  { value: 'pool-b', label: 'Allez USDC', apy: 8.91 },
  { value: 'pool-c', label: 'Steakhouse USDC High Yield', apy: 7.09 },
];