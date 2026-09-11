'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { StrategyCardProps } from '../../types/strategy';
import Primary from '../shared/Primary';
import Secondary from '../shared/Secondary';
import ArchiveStrategyModal from '../shared/ArchiveStrategyModal';
import styles from './StrategyCard.module.css';

type ExpandedPanel = 'funds' | 'details' | null;

function formatDetailDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function isValidFundAmount(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const n = Number(t);
  return Number.isFinite(n) && n > 0;
}

/** 百分比金額：勿用 Math.round，否則 capital=1、10% 會變 0 而非 0.1 */
function formatPctOfCapital(capital: number, pct: number): string {
  if (!Number.isFinite(capital)) return '0';
  const raw = (capital * pct) / 100;
  const n = parseFloat(raw.toFixed(9));
  return String(n);
}

export const StrategyCard: React.FC<StrategyCardProps> = ({
  strategy,
  onActivate,
  onDeactivate,
  onDeposit,
  onWithdraw,
  onArchive,
  isActivating = false,
}) => {
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<ExpandedPanel>(null);
  const [fundAmount, setFundAmount] = useState('100');
  const [fundFieldBlurred, setFundFieldBlurred] = useState(false);
  const [fundAddAttempted, setFundAddAttempted] = useState(false);

  const capital = strategy.capital ?? 0;
  const pnl = strategy.pnl ?? 0;
  const pnlPrefix = pnl >= 0 ? '+' : '';
  const hasNoFunds = capital === 0;
  const accountLife =
    strategy.accountLifecycle ?? (strategy.isActive ? 'active' : 'inactive');
  const isClosed = accountLife === 'closed';
  const noBoundAccount = accountLife === 'none';

  const healthWarning = hasNoFunds
    ? 'Insufficient funds'
    : strategy.healthWarning;
  const isInsufficientFunds = hasNoFunds;

  const togglePanel = useCallback((panel: ExpandedPanel) => {
    setExpandedPanel(prev => prev === panel ? null : panel);
  }, []);

  const handlePercentage = useCallback((pct: number) => {
    setFundAmount(formatPctOfCapital(capital, pct));
  }, [capital]);

  useEffect(() => {
    if (expandedPanel === 'funds') {
      setFundFieldBlurred(false);
      setFundAddAttempted(false);
    }
  }, [expandedPanel]);

  const fundInvalid = useMemo(() => !isValidFundAmount(fundAmount), [fundAmount]);
  const showFundInputError = fundInvalid && (fundFieldBlurred || fundAddAttempted);

  const handleAddFundsClick = useCallback(() => {
    if (!isValidFundAmount(fundAmount)) {
      setFundAddAttempted(true);
      return;
    }
    onDeposit?.(strategy.id);
  }, [fundAmount, onDeposit, strategy.id]);

  const handleWithdrawClick = useCallback(() => {
    if (!isValidFundAmount(fundAmount)) {
      setFundAddAttempted(true);
      return;
    }
    onWithdraw?.(strategy.id, fundAmount);
  }, [fundAmount, onWithdraw, strategy.id]);

  const cardHeight = expandedPanel === 'details' ? 523 : expandedPanel === 'funds' ? 363 : 202;

  return (
    <div className={styles.card} style={{ height: cardHeight }}>
      {/* Content area */}
      <div className={styles.contentArea}>
        <div className={styles.topRow}>
          <span className={`${styles.strategyName} ${strategy.isActive ? styles.nameActive : ''}`}>
            {strategy.title}
          </span>
          <div className={styles.menuWrapper}>
            <button
              type="button"
              className={styles.menuButton}
              aria-haspopup="dialog"
              aria-expanded={archiveModalOpen}
              aria-label="Strategy actions"
              onClick={() => setArchiveModalOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <rect x="9.17" y="9.17" width="1.67" height="1.67" rx="0.83" stroke="#0E0F28" strokeWidth="2" />
                <rect x="9.17" y="3.33" width="1.67" height="1.67" rx="0.83" stroke="#0E0F28" strokeWidth="2" />
                <rect x="9.17" y="15" width="1.67" height="1.67" rx="0.83" stroke="#0E0F28" strokeWidth="2" />
              </svg>
            </button>
          </div>
        </div>

        <div className={styles.statsRow}>
          <div className={styles.statBlock}>
            <span className={styles.statLabel}>Capital</span>
            <span className={styles.statValue}>${capital.toLocaleString()}</span>
          </div>
          <div className={styles.statBlock}>
            <span className={styles.statLabel}>PnL</span>
            <span className={styles.statValue}>
              {pnlPrefix}${Math.abs(pnl).toLocaleString()}
            </span>
          </div>
        </div>

        {healthWarning && (
          <div className={styles.healthPanel}>
            <div className={styles.healthDotCol}>
              <span className={`${styles.healthDot} ${isInsufficientFunds ? styles.healthDotDanger : ''}`} />
            </div>
            <span className={styles.healthText}>{healthWarning}</span>
          </div>
        )}
      </div>

      {/* Main button row — Figma: Funds/Details Secondary, Pause/Start Primary */}
      <div className={styles.buttonRow}>
        <Secondary className={styles.mainRowSecondary} onClick={() => togglePanel('funds')}>
          Funds
        </Secondary>
        <Secondary className={styles.mainRowSecondary} onClick={() => togglePanel('details')}>
          Details
        </Secondary>
        {isClosed ? (
          <Primary className={styles.mainRowPrimary} disabled>
            Closed
          </Primary>
        ) : expandedPanel === 'funds' ? (
          <Primary
            className={styles.mainRowPrimary}
            disabled={
              isActivating ||
              noBoundAccount ||
              (!strategy.isActive && hasNoFunds)
            }
            onClick={() =>
              strategy.isActive ? onDeactivate(strategy.id) : !hasNoFunds && onActivate(strategy.id)
            }
          >
            {strategy.isActive ? 'Pause' : 'Start'}
          </Primary>
        ) : strategy.isActive ? (
          <Primary
            className={styles.mainRowPrimary}
            disabled={isActivating}
            onClick={() => onDeactivate(strategy.id)}
          >
            Pause
          </Primary>
        ) : (
          <Primary
            className={styles.mainRowPrimary}
            disabled={isActivating || noBoundAccount || hasNoFunds}
            onClick={() => !hasNoFunds && onActivate(strategy.id)}
          >
            Start
          </Primary>
        )}
      </div>

      {/* Details expanded panel */}
      {expandedPanel === 'details' && (
        <div className={styles.expandedArea}>
          <div className={styles.detailGrid}>
            <div className={styles.detailCell}>
              <span className={styles.detailLabel}>Deploy Date</span>
              <span className={styles.detailValue}>{formatDetailDate(strategy.deployedAt)}</span>
            </div>
            <div className={styles.detailCell}>
              <span className={styles.detailLabel}>Activate Date</span>
              <span className={styles.detailValue}>
                {formatDetailDate(strategy.firstExecutionStartedAt)}
              </span>
            </div>
          </div>
          <div className={styles.detailGrid}>
            <div className={styles.detailCell}>
              <span className={styles.detailLabel}>Last Execution</span>
              <span className={styles.detailValue}>59 minutes ago</span>
            </div>
            <div className={styles.detailCell}>
              <span className={styles.detailLabel}>Status</span>
              <span className={styles.detailValue}>Healthy</span>
            </div>
          </div>
          <div className={styles.activityCard}>
            <span className={styles.activityTitle}>Activity</span>
            <div className={styles.activityList}>
              <div className={styles.activityRow}><span className={styles.activityTime}>23:59</span><span className={styles.activityDesc}>Trigger detected</span></div>
              <div className={styles.activityRow}><span className={styles.activityTime}>13:24</span><span className={styles.activityDesc}>Telegram notification</span></div>
              <div className={styles.activityRow}><span className={styles.activityTime}>10:59</span><span className={styles.activityDesc}>Transaction confirmed</span></div>
              <div className={styles.activityRow}><span className={styles.activityTime}>01:00</span><span className={styles.activityDesc}>Swap executed</span></div>
              <div className={styles.activityRow}><span className={styles.activityTime}>00:00</span><span className={styles.activityDesc}>Trigger detected</span></div>
            </div>
          </div>
        </div>
      )}

      {/* Funds expanded panel */}
      {expandedPanel === 'funds' && (
        <>
          <div className={styles.expandedArea}>
            <div className={styles.fundsInputRow}>
              <div
                className={`${styles.fundsInput} ${showFundInputError ? styles.fundsInputError : ''}`}
              >
                <div className={styles.fundsInputLeft}>
                  <img
                    src="/solana.svg"
                    alt=""
                    width={28}
                    height={21}
                    className={styles.fundsSolIcon}
                    aria-hidden
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    className={styles.fundsInputField}
                    value={fundAmount}
                    onChange={e => setFundAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    onBlur={() => setFundFieldBlurred(true)}
                    aria-invalid={showFundInputError}
                    aria-label="Amount in SOL"
                  />
                </div>
              </div>
            </div>
            <div className={styles.pctGrid}>
              <button type="button" className={styles.pctButton} onClick={() => handlePercentage(10)}>
                10%
              </button>
              <button type="button" className={styles.pctButton} onClick={() => handlePercentage(25)}>
                25%
              </button>
              <button type="button" className={styles.pctButton} onClick={() => handlePercentage(50)}>
                50%
              </button>
              <button type="button" className={styles.pctButton} onClick={() => handlePercentage(100)}>
                100%
              </button>
            </div>
          </div>
          <div className={styles.expandedButtonRow} style={{ top: 319 }}>
            <Secondary
              className={styles.expandedFooterBtn}
              disabled={noBoundAccount || fundInvalid}
              onClick={handleWithdrawClick}
              title={noBoundAccount ? 'No account linked' : undefined}
            >
              Withdraw
            </Secondary>
            <Primary className={styles.expandedFooterBtn} onClick={handleAddFundsClick}>
              Add Funds
            </Primary>
          </div>
        </>
      )}
      <ArchiveStrategyModal
        open={archiveModalOpen}
        strategyTitle={strategy.title}
        onClose={() => setArchiveModalOpen(false)}
        onConfirmArchive={() => {
          void onArchive?.(strategy.id);
        }}
      />
    </div>
  );
};
