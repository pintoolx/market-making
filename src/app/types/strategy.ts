// Strategy marketplace types

import { Workflow } from './workflow';

export interface Strategy {
  id: string;
  title: string;
  description: string;
  creator: string;
  category: string;
  tags: string[];
  rating: number;
  usageCount: number;
  isActive: boolean;
  /**
   * 綁定之 public.accounts 生命週期；none = 尚無 current_workflow_id 對應帳戶
   */
  accountLifecycle?: 'active' | 'inactive' | 'closed' | 'none';
  previewImage?: string;
  capital?: number;
  pnl?: number;
  healthWarning?: string;
  /** ISO 字串，來自 workflows.created_at */
  deployedAt?: string | null;
  /** ISO 字串，該 workflow 在 workflow_executions 最早的 started_at */
  firstExecutionStartedAt?: string | null;
}

export interface PublishedStrategy {
  id: string;
  workflowId: string;
  title: string;
  description: string;
  creator: {
    id: string;
    name: string;
    avatar?: string;
  };
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  publishedAt: Date;
  previewImage?: string;
  workflow: Workflow;
}

export interface UserStrategy {
  id: string;
  strategyId: string;
  userId: string;
  isActive: boolean;
  activatedAt: Date;
  customConfig?: Record<string, string | number | boolean>;
}

export interface FilterOptions {
  categories: string[];
  tags: string[];
  ratingRange: [number, number];
  sortBy: 'rating' | 'usage' | 'recent';
}

// Component prop interfaces for Workflows page
export interface StrategyMarketplaceProps {
  strategies: Strategy[];
  onStrategyActivate: (strategyId: string) => void;
  onStrategyDeactivate: (strategyId: string) => void;
  onStrategyEdit?: (strategyId: string) => void;
  onStrategyDeposit?: (strategyId: string) => void;
  onStrategyWithdraw?: (strategyId: string, amountInput: string) => void;
  onStrategyArchive?: (strategyId: string) => void;
  activatingId?: string | null;
  isLoading?: boolean;
}

export interface StrategyCardProps {
  strategy: Strategy;
  onActivate: (strategyId: string) => void;
  onDeactivate: (strategyId: string) => void;
  onDeposit?: (strategyId: string) => void;
  onWithdraw?: (strategyId: string, amountInput: string) => void;
  onEdit?: (strategyId: string) => void;
  onArchive?: (strategyId: string) => void;
  isActivating?: boolean;
}

export interface FilterPanelProps {
  filters: FilterOptions;
  onFilterChange: (filters: FilterOptions) => void;
}