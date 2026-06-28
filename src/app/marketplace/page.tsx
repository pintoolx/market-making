'use client';

import React, { useMemo, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import PreviewModal from './PreviewModal';
import styles from './page.module.css';

const SignInButton = dynamic(() => import('../components/shared/SignInButton'), {
  ssr: false,
  loading: () => <div style={{ width: '150px', height: '40px' }} />,
});

type StrategyItem = {
  id: string;
  name: string;
  creator: string;
  apy: string;
  risk: 'Low' | 'Medium' | 'High';
  runs: string;
  tags: string[];
};

const ALL_STRATEGIES: StrategyItem[] = [
  {
    id: 'f-1',
    name: 'Jupiter DCA Yield',
    creator: '0xAlpha.sol',
    apy: '22.4%',
    risk: 'Low',
    runs: '777.2K',
    tags: ['Stable yield', 'DCA', 'Jupiter', 'Kamino'],
  },
  {
    id: 'f-2',
    name: 'SOL Rebalance Pro',
    creator: '0xLuna.sol',
    apy: '18.1%',
    risk: 'Low',
    runs: '412.4K',
    tags: ['Growth', 'LP', 'Jupiter', 'SOL'],
  },
  {
    id: 'f-3',
    name: 'LST Carry Stack',
    creator: '0xNeon.sol',
    apy: '14.8%',
    risk: 'Medium',
    runs: '90.3K',
    tags: ['Stable yield', 'LP', 'LST', 'Kamino'],
  },
  {
    id: 'a-4',
    name: 'Mean Revert SOL',
    creator: '0xGamma.sol',
    apy: '11.3%',
    risk: 'Medium',
    runs: '7.2K',
    tags: ['Growth', 'Mean reversion', 'SOL'],
  },
  {
    id: 'a-5',
    name: 'USDC Delta Neutral',
    creator: '0xDelta.sol',
    apy: '9.6%',
    risk: 'Low',
    runs: '2K',
    tags: ['Hedging', 'Delta neutral', 'USDC'],
  },
  {
    id: 'a-6',
    name: 'Momentum Rotation',
    creator: '0xSigma.sol',
    apy: '16.2%',
    risk: 'High',
    runs: '600',
    tags: ['Growth', 'Momentum', 'Rotation'],
  },
  {
    id: 'a-7',
    name: 'Funding Arbitrage',
    creator: '0xVega.sol',
    apy: '13.0%',
    risk: 'Medium',
    runs: '1.6K',
    tags: ['Hedging', 'Arbitrage', 'Perps'],
  },
  {
    id: 'a-8',
    name: 'Lending Ladder',
    creator: '0xOrion.sol',
    apy: '8.9%',
    risk: 'Low',
    runs: '9.4K',
    tags: ['Stable yield', 'Lending', 'USDC'],
  },
  {
    id: 'a-9',
    name: 'DePIN Basket',
    creator: '0xNova.sol',
    apy: '20.2%',
    risk: 'High',
    runs: '14.2K',
    tags: ['Growth', 'Basket', 'DePIN'],
  },
];

// Featured row = last 3 entries of the full catalog.
const FEATURED: StrategyItem[] = ALL_STRATEGIES.slice(-3);

// Tiny PRNG seeded from strategy id so each card gets a stable but distinct curve
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}

function MiniChart({ seedKey }: { seedKey: string }) {
  const width = 261;
  const height = 106;
  const points = 18;

  const rand = makeRng(hashString(seedKey));
  const ys: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // Generally upward (y decreases over time) PnL trend
    const trend = (1 - t) * height * 0.72 + t * height * 0.22;
    const noise = (rand() - 0.5) * height * 0.2;
    ys.push(Math.max(8, Math.min(height - 6, trend + noise)));
  }
  const xs = ys.map((_, i) => (i / (points - 1)) * width);

  // Smooth quadratic line through points
  let line = `M ${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`;
  for (let i = 1; i < points; i++) {
    const cx = (xs[i] + xs[i - 1]) / 2;
    line += ` Q ${cx.toFixed(2)} ${ys[i - 1].toFixed(2)}, ${xs[i].toFixed(2)} ${ys[i].toFixed(2)}`;
  }
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  const gradId = `mini-fill-${hashString(seedKey).toString(36)}`;
  return (
    <svg
      className={styles.cardChart}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#2050F2" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#E4EAF2" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke="#2050F2"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StrategyCard({ item, onPreview }: { item: StrategyItem; onPreview: () => void }) {
  return (
    <article className={styles.card}>
      <div className={styles.cardBg} />
      <MiniChart seedKey={item.id} />
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <h3 className={styles.cardTitle}>{item.name}</h3>
        </div>
        <p className={styles.cardBy}>
          <span className={styles.cardByLabel}>by</span>
          <span className={styles.cardByCreator}>{item.creator}</span>
        </p>

        <div className={styles.metrics}>
          <div>
            <span className={styles.metricLabel}>APY (90d)</span>
            <span className={styles.metricValue}>{item.apy}</span>
          </div>
          <div>
            <span className={styles.metricLabel}>Risk</span>
            <span className={styles.metricValue}>{item.risk}</span>
          </div>
          <div>
            <span className={styles.metricLabel}>Runs</span>
            <span className={styles.metricValue}>{item.runs}</span>
          </div>
        </div>

        <div className={styles.tagRow}>
          {item.tags.map(tag => (
            <span key={tag} className={styles.tag}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.cardActions}>
        <Secondary className={styles.secondaryBtn} onClick={onPreview}>
          Preview
        </Secondary>
        <Primary className={styles.primaryBtn}>
          Buy
        </Primary>
      </div>
    </article>
  );
}

const CATEGORIES = ['All', 'Stable yield', 'Growth', 'DCA', 'LP', 'Hedging'] as const;
const RISK_LEVELS = ['Low', 'Medium', 'High'] as const;
const FREQUENCIES = ['Hourly', 'Daily', 'Weekly', 'Monthly'] as const;
const SORT_OPTIONS = ['APY', 'Risk', 'Followers', 'Recent'] as const;

type RiskToggleKey = 'stopLoss' | 'maxDrawdown' | 'autoPause';
const RISK_TOGGLES: { key: RiskToggleKey; title: string; subtitle: string }[] = [
  { key: 'stopLoss', title: 'Stop-loss enabled', subtitle: 'Strategy has built-in stop-loss' },
  { key: 'maxDrawdown', title: 'Max drawdown limit', subtitle: 'Auto-pauses if loss exceeds threshold' },
  { key: 'autoPause', title: 'Auto-pause on volatility', subtitle: 'Halts during market anomalies' },
];

const CAPITAL_MIN = 0.1;
const CAPITAL_MAX = 100;
const DRAWDOWN_MIN = 0;
const DRAWDOWN_MAX = 99;

type MenuKey = 'category' | 'risk' | 'capital' | 'frequency' | 'advanced' | 'sort';

export default function MarketplacePage() {
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedRisk, setSelectedRisk] = useState<string>('Risk Level');
  const [minCapital, setMinCapital] = useState<number>(100);
  const [selectedFrequency, setSelectedFrequency] = useState<string>('Frequency');
  const [selectedSort, setSelectedSort] = useState<string>('Recent');
  const [sortFlipped, setSortFlipped] = useState<boolean>(false);
  const [riskToggles, setRiskToggles] = useState<Record<RiskToggleKey, boolean>>({
    stopLoss: false,
    maxDrawdown: false,
    autoPause: false,
  });
  const [maxDrawdown, setMaxDrawdown] = useState<number>(50);
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const menuTimer = useRef<number | null>(null);
  const [previewItem, setPreviewItem] = useState<StrategyItem | null>(null);

  const openMenuHandler = useCallback((menu: MenuKey) => {
    if (menuTimer.current) {
      window.clearTimeout(menuTimer.current);
      menuTimer.current = null;
    }
    setOpenMenu(menu);
  }, []);

  const closeMenuWithDelay = useCallback(() => {
    if (menuTimer.current) {
      window.clearTimeout(menuTimer.current);
    }
    menuTimer.current = window.setTimeout(() => {
      setOpenMenu(null);
      menuTimer.current = null;
    }, 150);
  }, []);

  const capitalProgress = useMemo(
    () => ((minCapital - CAPITAL_MIN) / (CAPITAL_MAX - CAPITAL_MIN)) * 100,
    [minCapital],
  );
  const drawdownProgress = useMemo(
    () => ((maxDrawdown - DRAWDOWN_MIN) / (DRAWDOWN_MAX - DRAWDOWN_MIN)) * 100,
    [maxDrawdown],
  );

  // Featured strategies always show every featured card regardless of filter.
  // Only the "All strategies" grid below reacts to the category filter.
  const filteredAll = useMemo(
    () =>
      selectedCategory === 'All'
        ? ALL_STRATEGIES
        : ALL_STRATEGIES.filter(s => s.tags.includes(selectedCategory)),
    [selectedCategory],
  );
  const allCount = filteredAll.length;

  const searchSectionRef = useRef<HTMLElement | null>(null);

  const handleSearchFocus = () => {
    const scrollEl = mainScrollRef.current;
    const searchEl = searchSectionRef.current;
    if (!scrollEl || !searchEl) return;

    // 點擊搜尋框後，把搜尋區推到視窗上方附近，讓 search + strategies 更完整可見。
    const targetTop = Math.max(searchEl.offsetTop - 16, 0);
    scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' });
  };

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.topbarLogoLink} aria-label="Go to home">
          <Image src="/pintoolLogo.svg" alt="PinTool" width={190} height={40} priority />
        </Link>
        <div className={styles.topbarActions}>
          <Link href="/" className={styles.createBtnLink}>
            <Secondary>
              <span className={styles.createBtnInner}>
                <Image
                  src="/plus-square.svg"
                  alt=""
                  width={16}
                  height={16}
                  aria-hidden
                />
                Create
              </span>
            </Secondary>
          </Link>
          <SignInButton />
        </div>
      </header>

      <main ref={mainScrollRef} className={styles.mainScroll}>
        <div className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroOverlay}>
            <h1>
              Deploy proven DeFi strategies
              <span>in one click</span>
            </h1>
            <p>
              Browse strategies built by verified creators. Sub-second execution, near-zero fees
              — no code needed.
            </p>
          </div>
        </section>

        <section ref={searchSectionRef} className={styles.searchSection}>
          <FormInput
            fullWidth
            shellClassName={styles.searchInputShell}
            className={styles.searchInputField}
            placeholder="Search strategies"
            aria-label="Search strategies"
            onFocus={handleSearchFocus}
            leadingSlot={(
              <svg
                className={styles.searchIcon}
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden
              >
                <path
                  d="M11 19C15.4183 19 19 15.4183 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19Z"
                  stroke="#0E0F28"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M21 21L16.65 16.65"
                  stroke="#0E0F28"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          />
          <div className={styles.filterRow}>
            <div
              className={styles.menuAnchor}
              onMouseEnter={() => openMenuHandler('category')}
              onMouseLeave={closeMenuWithDelay}
            >
              <Secondary className={styles.filterBtn}>{selectedCategory}</Secondary>
              {openMenu === 'category' && (
                <div className={styles.menuDropdown}>
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => { setSelectedCategory(cat); setOpenMenu(null); }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className={styles.menuAnchor}
              onMouseEnter={() => openMenuHandler('risk')}
              onMouseLeave={closeMenuWithDelay}
            >
              <Secondary className={styles.filterBtn}>{selectedRisk}</Secondary>
              {openMenu === 'risk' && (
                <div className={styles.menuDropdown}>
                  {RISK_LEVELS.map(level => (
                    <button
                      key={level}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => { setSelectedRisk(level); setOpenMenu(null); }}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className={styles.menuAnchor}
              onMouseEnter={() => openMenuHandler('capital')}
              onMouseLeave={closeMenuWithDelay}
            >
              <Secondary className={styles.filterBtn}>Min Capital</Secondary>
              {openMenu === 'capital' && (
                <div className={`${styles.menuDropdown} ${styles.sliderDropdown}`}>
                  <div className={styles.sliderHeader}>
                    <span className={styles.sliderLabelLg}>Minimum</span>
                    <div className={styles.sliderValueGroup}>
                      <span className={styles.sliderValueBadge}>{minCapital}</span>
                      <span className={styles.sliderUnit}>SOL</span>
                    </div>
                  </div>
                  <div className={styles.sliderBody}>
                    <input
                      type="range"
                      min={CAPITAL_MIN}
                      max={CAPITAL_MAX}
                      step={0.1}
                      value={minCapital}
                      onChange={e => setMinCapital(Number(e.target.value))}
                      className={styles.slider}
                      style={{ ['--progress' as string]: `${capitalProgress}%` }}
                      aria-label="Minimum capital"
                    />
                    <div className={styles.sliderRange}>
                      <div className={styles.sliderRangeItem}>
                        <span className={styles.sliderRangeValue}>0.1</span>
                        <span className={styles.sliderRangeUnit}>SOL</span>
                      </div>
                      <div className={styles.sliderRangeItem}>
                        <span className={styles.sliderRangeValue}>100</span>
                        <span className={styles.sliderRangeUnit}>SOL</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div
              className={styles.menuAnchor}
              onMouseEnter={() => openMenuHandler('frequency')}
              onMouseLeave={closeMenuWithDelay}
            >
              <Secondary className={styles.filterBtn}>{selectedFrequency}</Secondary>
              {openMenu === 'frequency' && (
                <div className={styles.menuDropdown}>
                  {FREQUENCIES.map(f => (
                    <button
                      key={f}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => { setSelectedFrequency(f); setOpenMenu(null); }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className={styles.menuAnchor}
              onMouseEnter={() => openMenuHandler('advanced')}
              onMouseLeave={closeMenuWithDelay}
            >
              <Secondary className={styles.filterBtn}>Advanced</Secondary>
              {openMenu === 'advanced' && (
                <div className={`${styles.menuDropdown} ${styles.advancedDropdown}`}>
                  <div className={styles.advancedSection}>
                    <span className={styles.advancedSectionTitle}>Risk protection</span>
                    <div className={styles.toggleList}>
                      {RISK_TOGGLES.map(t => (
                        <button
                          key={t.key}
                          type="button"
                          className={styles.toggleRow}
                          onClick={() =>
                            setRiskToggles(prev => ({ ...prev, [t.key]: !prev[t.key] }))
                          }
                          aria-pressed={riskToggles[t.key]}
                        >
                          <div className={styles.toggleRowText}>
                            <span className={styles.toggleRowTitle}>{t.title}</span>
                            <span className={styles.toggleRowSubtitle}>{t.subtitle}</span>
                          </div>
                          <div
                            className={`${styles.toggle} ${
                              riskToggles[t.key] ? styles.toggleOn : ''
                            }`}
                          >
                            <div className={styles.toggleHalfL} />
                            <div className={styles.toggleHalfR} />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={styles.advancedSection}>
                    <div className={styles.sliderHeader}>
                      <span className={styles.advancedSectionTitle}>Max drawdown</span>
                      <div className={styles.sliderValueGroup}>
                        <span className={styles.sliderValueBadge}>{maxDrawdown}</span>
                        <span className={styles.sliderUnit}>%</span>
                      </div>
                    </div>
                    <div className={styles.sliderBody}>
                      <input
                        type="range"
                        min={DRAWDOWN_MIN}
                        max={DRAWDOWN_MAX}
                        step={1}
                        value={maxDrawdown}
                        onChange={e => setMaxDrawdown(Number(e.target.value))}
                        className={styles.slider}
                        style={{ ['--progress' as string]: `${drawdownProgress}%` }}
                        aria-label="Max drawdown"
                      />
                      <div className={styles.sliderRange}>
                        <div className={styles.sliderRangeItem}>
                          <span className={styles.sliderRangeValue}>0</span>
                          <span className={styles.sliderRangeUnit}>%</span>
                        </div>
                        <div className={styles.sliderRangeItem}>
                          <span className={styles.sliderRangeValue}>99</span>
                          <span className={styles.sliderRangeUnit}>%</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <Primary
                    className={styles.applyBtn}
                    fullWidth
                    onClick={() => setOpenMenu(null)}
                  >
                    Apply Search
                  </Primary>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Featured strategies</h2>
          <div className={styles.grid}>
            {FEATURED.map(item => (
              <StrategyCard
                key={item.id}
                item={item}
                onPreview={() => setPreviewItem(item)}
              />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTop}>
            <div className={styles.allHeader}>
              <h2 className={styles.sectionTitle}>All strategies</h2>
              <span className={styles.results}>{allCount} results</span>
            </div>
            <div
              className={styles.sortGroup}
              onMouseEnter={() => openMenuHandler('sort')}
              onMouseLeave={closeMenuWithDelay}
            >
              <button
                type="button"
                className={styles.sortIconBtn}
                onClick={() => setSortFlipped(prev => !prev)}
                aria-label="Toggle sort direction"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden
                >
                  <path
                    d="M9 10L12 13L15 10"
                    stroke={sortFlipped ? '#2050F2' : '#0E0F28'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 13L12 3"
                    stroke={sortFlipped ? '#2050F2' : '#0E0F28'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M7 6L4 3L1 6"
                    stroke={sortFlipped ? '#0E0F28' : '#2050F2'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4 3V13"
                    stroke={sortFlipped ? '#0E0F28' : '#2050F2'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button type="button" className={styles.sortBtn}>{selectedSort}</button>
              {openMenu === 'sort' && (
                <div className={`${styles.menuDropdown} ${styles.sortDropdown}`}>
                  {SORT_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => { setSelectedSort(opt); setOpenMenu(null); }}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className={styles.grid}>
            {filteredAll.map(item => (
              <StrategyCard
                key={item.id}
                item={item}
                onPreview={() => setPreviewItem(item)}
              />
            ))}
          </div>
        </section>
        </div>
      </main>

      {previewItem && (
        <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
      )}
    </div>
  );
}
