'use client';

import React from 'react';
import { StrategyMarketplaceProps } from '../../types/strategy';
import { StrategyCard } from './StrategyCard';
import styles from './StrategyMarketplace.module.css';

export const StrategyMarketplace: React.FC<StrategyMarketplaceProps> = ({
  strategies,
  onStrategyActivate,
  onStrategyDeactivate,
  onStrategyEdit,
  onStrategyDeposit,
  onStrategyWithdraw,
  onStrategyArchive,
  activatingId,
  isLoading: isLoadingProp,
}) => {
  const isLoading = isLoadingProp ?? false;

  return (
    <div className={styles.marketplace}>
      <div className={styles.content}>
        {isLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.loadingSpinner} />
            <p className={styles.loadingText}>Loading strategies...</p>
          </div>
        ) : strategies.length === 0 ? (
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>No strategies available</h3>
            <p className={styles.emptyDescription}>
              Deploy a workflow from the Creator to see it here.
            </p>
          </div>
        ) : (
          <div className={styles.strategiesGrid}>
            {strategies.map(strategy => (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
                onActivate={onStrategyActivate}
                onDeactivate={onStrategyDeactivate}
                onDeposit={onStrategyDeposit}
                onWithdraw={onStrategyWithdraw}
                onEdit={onStrategyEdit}
                onArchive={onStrategyArchive}
                isActivating={activatingId === strategy.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
