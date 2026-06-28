import { Strategy } from '../types/strategy';

export const mockStrategies: Strategy[] = [
  {
    id: '1',
    title: 'DCA Bitcoin',
    description: 'A dollar-cost averaging strategy for Bitcoin that automatically buys at regular intervals regardless of price. Perfect for long-term accumulation with built-in risk management.',
    creator: 'CryptoMaster',
    category: 'DeFi Strategies',
    tags: ['Beginner', 'Low Risk', 'Automated', 'Long Term'],
    rating: 4.8,
    usageCount: 1247,
    isActive: true,
    previewImage: '/api/placeholder/300/120'
  },
  {
    id: '2',
    title: 'Arbitrage Hunter Pro',
    description: 'Advanced arbitrage strategy that identifies price differences across multiple exchanges and executes trades automatically. High-frequency trading with sophisticated risk controls.',
    creator: 'ArbitrageKing',
    category: 'Arbitrage',
    tags: ['Advanced', 'High Frequency', 'Automated', 'High Yield'],
    rating: 4.6,
    usageCount: 892,
    isActive: false
  },
  {
    id: '3',
    title: 'Yield Farm Optimizer',
    description: 'Automatically finds and switches between the highest yielding DeFi protocols. Includes impermanent loss protection and gas optimization strategies.',
    creator: 'DeFiGuru',
    category: 'Yield Farming',
    tags: ['Advanced', 'High Yield', 'Automated', 'DeFi'],
    rating: 4.4,
    usageCount: 634,
    isActive: true
  },
  {
    id: '4',
    title: 'Scalping Bot Elite',
    description: 'High-speed scalping strategy designed for volatile markets. Uses technical indicators and machine learning to identify quick profit opportunities.',
    creator: 'ScalpingPro',
    category: 'Trading Bots',
    tags: ['Advanced', 'High Frequency', 'Scalping', 'Automated'],
    rating: 4.2,
    usageCount: 456,
    isActive: false
  },
  {
    id: '5',
    title: 'Portfolio Rebalancer Advanced Strategy',
    description: 'Maintains optimal portfolio allocation by automatically rebalancing assets based on market conditions and predefined targets. Great for passive investors.',
    creator: 'BalanceBot',
    category: 'Portfolio Management',
    tags: ['Beginner', 'Low Risk', 'Automated', 'Long Term'],
    rating: 4.7,
    usageCount: 1089,
    isActive: true
  },
  {
    id: '6',
    title: 'Market Making Strategy',
    description: 'Provides liquidity to order books while capturing spread profits. Includes dynamic pricing and inventory management for consistent returns.',
    creator: 'LiquidityProvider',
    category: 'Market Making',
    tags: ['Advanced', 'Market Making', 'Automated', 'Manual'],
    rating: 4.1,
    usageCount: 278,
    isActive: false
  },
  {
    id: '7',
    title: 'Swing Trading Assistant Pro Version',
    description: 'Identifies swing trading opportunities using technical analysis and sentiment indicators. Perfect for traders who prefer medium-term positions.',
    creator: 'SwingMaster',
    category: 'Trading Bots',
    tags: ['Beginner', 'Swing Trading', 'Manual', 'Technical Analysis'],
    rating: 4.5,
    usageCount: 723,
    isActive: true
  },
  {
    id: '8',
    title: 'Risk Parity Allocator',
    description: 'Advanced portfolio strategy that allocates risk equally across different asset classes. Includes volatility targeting and correlation analysis.',
    creator: 'RiskManager',
    category: 'Portfolio Management',
    tags: ['Advanced', 'Low Risk', 'Automated', 'Long Term'],
    rating: 4.3,
    usageCount: 412,
    isActive: false
  },
  {
    id: '9',
    title: 'Momentum Breakout Bot',
    description: 'Captures momentum breakouts using volume and price action analysis. Includes stop-loss and take-profit mechanisms for risk management.',
    creator: 'MomentumTrader',
    category: 'Trading Bots',
    tags: ['Beginner', 'Automated', 'Breakout', 'Technical Analysis'],
    rating: 4.0,
    usageCount: 567,
    isActive: true
  },
  {
    id: '10',
    title: 'Cross-Chain Yield Hunter',
    description: 'Finds the best yield opportunities across multiple blockchain networks. Automatically bridges assets and compounds rewards for maximum returns.',
    creator: 'CrossChainExpert',
    category: 'Yield Farming',
    tags: ['Advanced', 'High Yield', 'Automated', 'Cross-Chain'],
    rating: 4.6,
    usageCount: 345,
    isActive: false
  }
];