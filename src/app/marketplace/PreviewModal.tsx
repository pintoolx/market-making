'use client';

import React, { useEffect, useState } from 'react';
import Primary from '../components/shared/Primary';
import MarketplaceDeployModal from './MarketplaceDeployModal';
import styles from './PreviewModal.module.css';

export interface PreviewItem {
  name: string;
  creator: string;
  apy: string;
  risk: 'Low' | 'Medium' | 'High';
  runs: string;
  tags: string[];
}

interface PreviewModalProps {
  item: PreviewItem;
  onClose: () => void;
}

type PreviewOption = 'strategy' | 'creator';

type StepCard = {
  kind: 'card';
  label: string;
  bold: string;
  sub: string;
  boldColor?: string;
  icon: string;
};
type StepEntry = StepCard | { kind: 'sep' };

const DEFAULT_STEP_ICON = '/logic.svg';

// Trigger step variants — driven by the strategy "shape" tag.
const TRIGGER_BY_TAG: Record<string, StepCard> = {
  DCA: {
    kind: 'card',
    label: 'Activate a',
    bold: 'DCA Trigger',
    sub: 'Recurring buy schedule',
    icon: DEFAULT_STEP_ICON,
  },
  Rebalance: {
    kind: 'card',
    label: 'Activate a',
    bold: 'Rebalance Trigger',
    sub: 'Threshold-based rebalance',
    icon: DEFAULT_STEP_ICON,
  },
  Carry: {
    kind: 'card',
    label: 'Activate a',
    bold: 'Carry Trigger',
    sub: 'Funding-rate watch',
    icon: DEFAULT_STEP_ICON,
  },
  'Mean reversion': {
    kind: 'card',
    label: 'Activate a',
    bold: 'Mean Trigger',
    sub: 'Z-score detector',
    icon: DEFAULT_STEP_ICON,
  },
  Momentum: {
    kind: 'card',
    label: 'Activate a',
    bold: 'Momentum Trigger',
    sub: 'Trend detector',
    icon: DEFAULT_STEP_ICON,
  },
  Arbitrage: {
    kind: 'card',
    label: 'Activate an',
    bold: 'Arb Trigger',
    sub: 'Spread monitor',
    icon: DEFAULT_STEP_ICON,
  },
  Lending: {
    kind: 'card',
    label: 'Activate a',
    bold: 'Yield Trigger',
    sub: 'Rate monitor',
    icon: DEFAULT_STEP_ICON,
  },
  Basket: {
    kind: 'card',
    label: 'Activate a',
    bold: 'Basket Trigger',
    sub: 'Periodic rebalance',
    icon: DEFAULT_STEP_ICON,
  },
  'Delta neutral': {
    kind: 'card',
    label: 'Activate a',
    bold: 'Hedge Trigger',
    sub: 'Delta monitor',
    icon: DEFAULT_STEP_ICON,
  },
  'Stable yield': {
    kind: 'card',
    label: 'Activate a',
    bold: 'Yield Trigger',
    sub: 'Stable-coin yield monitor',
    icon: DEFAULT_STEP_ICON,
  },
};

// Action step variants — driven by the protocol tag (first match wins).
const ACTION_BY_TAG: Record<string, StepCard> = {
  Jupiter: {
    kind: 'card',
    label: 'Swap on',
    bold: 'Jupiter',
    sub: 'Protocol: Jupiter · DEX',
    icon: '/jupiter.svg',
  },
  Kamino: {
    kind: 'card',
    label: 'Deposit to',
    bold: 'Kamino',
    sub: 'Protocol: Kamino · Lending',
    icon: '/kamino.svg',
  },
  Pyth: {
    kind: 'card',
    label: 'Read price from',
    bold: 'Pyth',
    sub: 'Source: Pyth Oracle',
    icon: '/pyth.svg',
  },
  Binance: {
    kind: 'card',
    label: 'Read price from',
    bold: 'Binance',
    sub: 'Source: Binance feed',
    icon: '/binance.svg',
  },
  LST: {
    kind: 'card',
    label: 'Stake to',
    bold: 'LST',
    sub: 'Liquid staking token',
    icon: '/jitosol.svg',
  },
  Perps: {
    kind: 'card',
    label: 'Open position on',
    bold: 'Drift',
    sub: 'Protocol: Drift · Perp',
    icon: DEFAULT_STEP_ICON,
  },
  DePIN: {
    kind: 'card',
    label: 'Allocate to',
    bold: 'DePIN basket',
    sub: 'Sector basket',
    icon: DEFAULT_STEP_ICON,
  },
};

const DEFAULT_ACTION_STEP: StepCard = {
  kind: 'card',
  label: 'Open position on',
  bold: 'Drift',
  sub: 'Protocol: Drift · Perp',
  icon: DEFAULT_STEP_ICON,
};

const DEFAULT_TRIGGER_STEP: StepCard = {
  kind: 'card',
  label: 'Activate a',
  bold: 'Trigger',
  sub: 'Active after subscribe',
  icon: DEFAULT_STEP_ICON,
};

function buildHarvestStep(tags: string[]): StepCard {
  const isStable = tags.includes('USDC') || tags.includes('Stable yield');
  const harvestBold = isStable ? 'USDC' : 'SOL';
  const harvestIcon = isStable ? DEFAULT_STEP_ICON : '/solana.svg';

  let frequency = 'about weekly';
  if (tags.includes('DCA')) frequency = 'daily';
  else if (tags.includes('Lending')) frequency = 'continuous';
  else if (tags.includes('Rebalance')) frequency = 'on rebalance';
  else if (tags.includes('Arbitrage')) frequency = 'on each arb';

  return {
    kind: 'card',
    label: 'Harvest to',
    bold: harvestBold,
    boldColor: '#2050F2',
    sub: `Frequency: ${frequency} & Auto-compound`,
    icon: harvestIcon,
  };
}

function buildSteps(tags: string[]): StepEntry[] {
  const triggerStep =
    tags.map((t) => TRIGGER_BY_TAG[t]).find(Boolean) ?? DEFAULT_TRIGGER_STEP;
  const actionStep =
    tags.map((t) => ACTION_BY_TAG[t]).find(Boolean) ?? DEFAULT_ACTION_STEP;
  const harvestStep = buildHarvestStep(tags);

  return [triggerStep, { kind: 'sep' }, actionStep, { kind: 'sep' }, harvestStep];
}

function CheckIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12L10 17L20 7"
        stroke="#2050F2"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M19.5999 18.1998V14.8398L21.1199 8.11977L16.5599 9.23977L11.9999 4.75977L7.43988 9.23977L2.87988 8.11977L4.39988 14.8398V18.1998H19.5999Z"
        fill="#2050F2"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6L18 18M18 6L6 18" stroke="#0E0F28" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StepDots() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="6" r="1.5" fill="#0E0F28" />
      <circle cx="14" cy="14" r="1.5" fill="#0E0F28" />
      <circle cx="14" cy="22" r="1.5" fill="#0E0F28" />
    </svg>
  );
}

export default function PreviewModal({ item, onClose }: PreviewModalProps) {
  const [option, setOption] = useState<PreviewOption>('strategy');
  const [deployOpen, setDeployOpen] = useState<boolean>(false);
  const isStrategy = option === 'strategy';
  const steps = React.useMemo(() => buildSteps(item.tags), [item.tags]);

  const handleActivate = () => {
    setDeployOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.card}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${item.name}`}
      >
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close preview"
        >
          <CloseIcon />
        </button>

        <div className={styles.left}>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>{item.name}</h2>
            <p className={styles.byLine}>
              <span className={styles.byLabel}>by</span>
              <span className={styles.byCreator}>{item.creator}</span>
            </p>
          </div>

          <div className={styles.detailsBlock}>
            <div className={styles.detailsHeader}>
              <h3 className={styles.detailsTitle}>Strategy Details</h3>
              <p className={styles.detailsDesc}>
                Encrypted on-chain via Magicblock. Only your strategy wallet can execute them
                after subscribing.
              </p>
            </div>

            <div className={styles.steps}>
              {steps.map((step, i) => {
              if (step.kind === 'sep') {
                return (
                  <div key={`sep-${i}`} className={styles.stepSeparator}>
                    <StepDots />
                  </div>
                );
              }
              return (
                <div key={`card-${i}`} className={styles.stepCard}>
                  <img
                    src={step.icon}
                    alt=""
                    className={styles.stepIcon}
                    aria-hidden
                    onError={(e) => {
                      // Fallback to default logic icon if asset missing
                      const target = e.currentTarget;
                      if (target.src.endsWith(DEFAULT_STEP_ICON)) return;
                      target.src = DEFAULT_STEP_ICON;
                    }}
                  />
                  <div className={styles.stepText}>
                    <div className={styles.stepLine}>
                      <span className={styles.stepLabel}>{step.label}</span>
                      <span
                        className={styles.stepBold}
                        style={step.boldColor ? { color: step.boldColor } : undefined}
                      >
                        {step.bold}
                      </span>
                    </div>
                    <span className={styles.stepSub}>{step.sub}</span>
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        </div>

        <div className={styles.right}>
          <div className={styles.optionRow}>
            <button
              type="button"
              className={`${styles.optionCard} ${isStrategy ? styles.optionSelected : ''}`}
              onClick={() => setOption('strategy')}
              aria-pressed={isStrategy}
            >
              <div className={styles.optionLine}>
                <span className={styles.optionLabel}>Buy this</span>
                <span className={styles.optionBold}>Strategy</span>
              </div>
              <span className={styles.optionSub}>Use {item.name}</span>
              <span className={styles.optionSub}>Cancel anytime.</span>
            </button>
            <button
              type="button"
              className={`${styles.optionCard} ${!isStrategy ? styles.optionSelected : ''}`}
              onClick={() => setOption('creator')}
              aria-pressed={!isStrategy}
            >
              <span className={styles.recommendBadge}>Recommend</span>
              <div className={styles.optionLine}>
                <span className={styles.optionLabel}>All of</span>
                <span className={styles.optionBold}>{item.creator}</span>
              </div>
              <span className={styles.optionSub}>Unlock every strategy from this creator.</span>
            </button>
          </div>

          <div className={styles.stats}>
            <div className={styles.statRow}>
              <span className={styles.statKey}>APY</span>
              <span className={styles.statValueGroup}>
                <span className={styles.statApyPlus}>+</span>
                <span className={styles.statApyValue}>{item.apy}</span>
                <span className={styles.statApyUnit}> (90D)</span>
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Risk</span>
              <span className={styles.statValue}>{item.risk}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Runs</span>
              <span className={styles.statValue}>{item.runs} total</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Min Capital</span>
              <span className={styles.statValue}>0.5 SOL</span>
            </div>
          </div>

          <ul
            className={`${styles.checklist} ${!isStrategy ? styles.checklistCreator : ''}`}
          >
            {!isStrategy && (
              <li>
                <CrownIcon />
                <span>Access all strategies by this creator.</span>
              </li>
            )}
            <li>
              <CheckIcon />
              <span>Executes via smart contract</span>
            </li>
            <li>
              <CheckIcon />
              <span>Isolated from your main wallet</span>
            </li>
            <li>
              <CheckIcon />
              <span>Creator has zero access</span>
            </li>
          </ul>

          <div className={styles.priceCta}>
            <div className={styles.priceRow}>
              <span className={styles.priceLabel}>Price</span>
              <span className={styles.priceValue}>
                {isStrategy ? (
                  '0.2 SOL'
                ) : (
                  <>
                    0.5 SOL <span className={styles.pricePeriod}>/ month</span>
                  </>
                )}
              </span>
            </div>
            <Primary className={styles.cta} onClick={handleActivate}>
              {isStrategy ? 'Activate' : 'Subscribe'}
            </Primary>
          </div>

          <div className={styles.warning}>
            <span className={styles.warningDot} aria-hidden />
            <span>
              Minimum {isStrategy ? '0.8' : '1'} SOL required in your strategy wallet before
              activation.
            </span>
          </div>
        </div>
      </div>

      {deployOpen && (
        <MarketplaceDeployModal
          strategyName={item.name}
          onClose={() => setDeployOpen(false)}
          onActivated={() => {
            setDeployOpen(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}
