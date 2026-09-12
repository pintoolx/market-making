'use client';

import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { createMandate, getMandate, type MandateState } from './mandateClient';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { useProposals } from './proposalStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const STEPS = ['Choose strategies', 'Set private limits', 'Review', 'Monitor'];
const FEATURED: Listing[] = [
  {
    id: 'featured-tight-market',
    name: 'Tight Market',
    summary: 'Quotes WETH / USDC with a tighter spread when market conditions support active liquidity.',
    template: AQUA_TEMPLATES[0],
    mine: false,
    provider: 'PinTool Strategies',
  },
  {
    id: 'featured-defensive-market',
    name: 'Defensive Market',
    summary: 'Widens execution bounds and reduces WETH exposure as market risk increases.',
    template: AQUA_TEMPLATES[0],
    mine: false,
    provider: 'PinTool Strategies',
  },
];

type Phase = 'choose' | 'limits' | 'review' | 'submitting' | 'monitor';

const toNumber = (value: string) => Number(value.replace(/,/g, '').trim());
const positiveError = (value: string) => !value.trim() ? '' : !(toNumber(value) > 0) ? 'Enter an amount above 0.' : '';
const percentageError = (value: string) => {
  const n = toNumber(value);
  return !value.trim() ? '' : !(n > 0 && n <= 100) ? 'Enter a percentage between 1 and 100.' : '';
};
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export default function MakerFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const { published } = usePublishedListings();
  const { save } = useProposals();
  const [selected, setSelected] = useState<Listing[]>([]);
  const [budget, setBudget] = useState('1000');
  const [exposure, setExposure] = useState('60');
  const [maxWethInventory, setMaxWethInventory] = useState('350');
  const [maxTrade, setMaxTrade] = useState('100');
  const [validityMinutes, setValidityMinutes] = useState('10');
  const [phase, setPhase] = useState<Phase>('choose');
  const [mandate, setMandate] = useState<MandateState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [phase]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('strategy');
    if (!id) return;
    const listing = [...readPublished(), ...FEATURED].find(item => item.id === id);
    if (listing) setSelected([listing]);
    window.history.replaceState(null, '', '/maker');
  }, []);

  const listings = [...published, ...FEATURED.filter(sample => !published.some(item => item.id === sample.id))];
  const go = (next: Phase) => {
    didNavigate.current = true;
    scrollTop();
    setError('');
    setPhase(next);
  };
  const toggle = (listing: Listing) => {
    setSelected(current => current.some(item => item.id === listing.id)
      ? current.filter(item => item.id !== listing.id)
      : [...current, listing]);
  };

  const valid = [budget, maxWethInventory, maxTrade, validityMinutes].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
    && toNumber(maxWethInventory) <= toNumber(budget)
    && toNumber(maxTrade) <= toNumber(budget);

  const savePolicy = () => {
    if (!valid || selected.length === 0) return;
    selected.forEach(item => save({
      id: item.id,
      strategyName: item.name,
      mechanism: item.template.label,
      budget: budget.trim(),
      maxExposure: exposure.trim(),
      maxWeakAsset: maxWethInventory.trim(),
      maxTrade: maxTrade.trim(),
      validityMinutes: validityMinutes.trim(),
      feePct: item.feePct,
    }));
    go('review');
  };

  const submit = async () => {
    if (!account.address || selected.length === 0) {
      setError('Log in with the Maker wallet before creating the mandate.');
      return;
    }
    go('submitting');
    try {
      const state = await createMandate({
        maker: account.address,
        providerStrategyIds: selected.map(item => item.id),
        policy: {
          capitalBudgetUsdc: budget.trim(),
          maxWethExposurePct: exposure.trim(),
          maxWethInventoryUsdc: maxWethInventory.trim(),
          maxSwapUsdc: maxTrade.trim(),
          validityMinutes: validityMinutes.trim(),
        },
      });
      setMandate(state);
      go('monitor');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The mandate could not be created.');
      setPhase('review');
    }
  };

  const refresh = async () => {
    if (!mandate) return;
    setRefreshing(true);
    setError('');
    try {
      setMandate(await getMandate(mandate.mandateId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The mandate status could not be refreshed.');
    } finally {
      setRefreshing(false);
    }
  };

  const currentStep = phase === 'choose' ? 0 : phase === 'limits' ? 1 : ['review', 'submitting'].includes(phase) ? 2 : 3;
  const title = phase === 'choose' ? 'Build your strategy set.'
    : phase === 'limits' ? 'Set one boundary for your capital.'
      : phase === 'review' ? 'Review your mandate.'
        : phase === 'submitting' ? 'Creating your mandate.'
          : 'Your liquidity mandate.';

  return <section className={aqua.flow}>
    {phase !== 'choose' && phase !== 'monitor' && <button type="button" className={aqua.backLink} onClick={() => go('choose')}>← Strategy marketplace</button>}
    <PageHead eyebrow="Maker Marketplace" title={title} accent={phase === 'monitor' ? 'One balance, guarded continuously.' : undefined} headingRef={heading}>
      {phase === 'choose' && 'Choose the private strategies that may compete for your Aqua liquidity. You control the capital boundary they all share.'}
      {phase === 'limits' && 'Providers never receive your original WETH exposure, inventory or fill limits.'}
      {phase === 'review' && 'The confidential workflow will decide which eligible strategy may use your liquidity.'}
      {phase === 'submitting' && 'Checking Provider policies against your limits and waiting for the Guard report to be confirmed.'}
      {phase === 'monitor' && 'Track the currently authorized strategy and every confirmed execution decision.'}
    </PageHead>
    <Steps steps={STEPS} current={currentStep} />
    {error && <div className={aqua.errorNotice} role="alert"><strong>Action required</strong><span>{error}</span></div>}

    {phase === 'choose' && <>
      <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Available strategies</h2><span className={aqua.muted}>{selected.length} selected</span></div>
      <div className={`${styles.grid} ${aqua.grid}`}>
        {listings.map(item => {
          const chosen = selected.some(entry => entry.id === item.id);
          return <ListingCard key={item.id} listing={item} action={<Secondary aria-pressed={chosen} onClick={() => toggle(item)}>{chosen ? 'Added to mandate' : 'Add to mandate'}</Secondary>} />;
        })}
      </div>
      <div className={aqua.selectionBar}>
        <div><span className={aqua.eyebrow}>Your strategy set</span><strong>{selected.length ? `${selected.length} ${selected.length === 1 ? 'strategy' : 'strategies'} selected` : 'Choose at least one strategy'}</strong></div>
        <Primary disabled={selected.length === 0} onClick={() => go('limits')}>Set capital limits</Primary>
      </div>
    </>}

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private mandate</legend>
          <p className={aqua.muted}>These limits apply across every strategy in your set.</p>
          <label>Capital budget (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={event => setBudget(event.target.value)} /></label>
          <label>Maximum WETH exposure (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={event => setExposure(event.target.value)} /></label>
          <label>Maximum WETH inventory (USDC value)<FormInput inputMode="decimal" value={maxWethInventory} aria-invalid={!!positiveError(maxWethInventory) || toNumber(maxWethInventory) > toNumber(budget)} onChange={event => setMaxWethInventory(event.target.value)} /></label>
          <label>Maximum amount per swap (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={event => setMaxTrade(event.target.value)} /></label>
          <label>Mandate validity (minutes)<FormInput inputMode="numeric" value={validityMinutes} aria-invalid={!!positiveError(validityMinutes)} onChange={event => setValidityMinutes(event.target.value)} /><span className={aqua.hint}>Trading stops when the latest authorization expires.</span></label>
        </fieldset>
        <Primary type="submit" disabled={!valid}>Review mandate</Primary>
      </form>
      <aside className={aqua.explanation}><h2>One policy across your strategy set</h2><ul className={aqua.trustList}><li>Funds remain in your Maker wallet.</li><li>Provider policies may narrow your limits, never expand them.</li><li>PinTool Guard permits at most one strategy at a time.</li></ul><h3>Execution pair</h3><p>WETH / USDC strategies share Aqua liquidity without moving capital when authorization changes.</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <StrategySet selected={selected} />
        <PolicyMetrics budget={budget} exposure={exposure} maxWethInventory={maxWethInventory} maxTrade={maxTrade} validity={validityMinutes} />
        <div className={aqua.actionRow}><Primary onClick={submit}>Create confidential mandate</Primary><Secondary onClick={() => go('limits')}>Edit limits</Secondary></div>
      </div>
      <PrivacyRoute />
    </div>}

    {phase === 'submitting' && <RuntimePanel />}
    {phase === 'monitor' && mandate && <MandateMonitor mandate={mandate} refreshing={refreshing} onRefresh={refresh} />}
  </section>;
}

function StrategySet({ selected }: { selected: Listing[] }) {
  return <div className={aqua.providerPair}>{selected.map(item => <div key={item.id}><span>{item.provider ?? 'Independent Provider'}</span><strong>{item.name}</strong><small>{item.template.label}</small></div>)}</div>;
}

function PolicyMetrics({ budget, exposure, maxWethInventory, maxTrade, validity }: { budget: string; exposure: string; maxWethInventory: string; maxTrade: string; validity: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>WETH exposure</span><strong>{exposure}% max</strong></div><div><span>WETH inventory</span><strong>{maxWethInventory} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Authorization validity</span><strong>{validity} minutes</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>Disclosure boundary</span><h2>Only the mandate leaves the TEE.</h2><div><span>Provider policies</span><strong>Confidential</strong></div><div><span>Maker limits</span><strong>Confidential</strong></div><div><span>Authorization</span><strong>Public and enforceable</strong></div></aside>;
}

function RuntimePanel() {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>Chainlink Confidential Workflow</span><h2>Evaluating your strategy set</h2><p>Applying your hard limits and waiting for the resulting PinTool Guard state to be confirmed onchain.</p></div><ol className={aqua.runtimeSteps}><li data-done>Strategy set received</li><li data-done>Maker mandate received</li><li data-active>Private policies being evaluated</li><li>Guard confirmation</li></ol></div>;
}

function MandateMonitor({ mandate, refreshing, onRefresh }: { mandate: MandateState; refreshing: boolean; onRefresh: () => void }) {
  const active = mandate.strategies.find(item => item.status === 'active');
  const expires = new Date(mandate.evidence.expiresAt);
  return <div className={aqua.monitorLayout}>
    <section className={aqua.panel}>
      <div className={aqua.statusHeader}><span className={aqua.statusMark}>✓</span><div><span className={aqua.eyebrow}>Mandate sequence {mandate.evidence.sequence}</span><h2>{active ? active.name : 'No strategy currently authorized'}</h2></div></div>
      <div className={aqua.intentRows}><div><span>Market state</span><strong>{mandate.regime === 'high-volatility' ? 'High volatility' : mandate.regime === 'normal' ? 'Normal' : 'Evaluating'}</strong></div><div><span>Pair</span><strong>WETH / USDC</strong></div><div><span>Network</span><strong>{mandate.evidence.networkName}</strong></div><div><span>Authorization expires</span><strong>{Number.isNaN(expires.valueOf()) ? mandate.evidence.expiresAt : expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></div></div>
      <div className={aqua.actionRow}><Primary disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh status'}</Primary><a className={aqua.evidenceLink} href={mandate.evidence.reportExplorerUrl} target="_blank" rel="noreferrer">View Guard update ↗</a></div>
    </section>

    <section className={aqua.strategyRoster} aria-labelledby="strategy-roster-title">
      <div className={aqua.sectionTop}><h2 id="strategy-roster-title" className={aqua.sectionTitle}>Strategy set</h2><span className={aqua.muted}>One shared balance</span></div>
      {mandate.strategies.map(strategy => <article key={strategy.listingId} className={aqua.rosterRow} data-status={strategy.status}>
        <div><span className={aqua.eyebrow}>{strategy.provider ?? 'Strategy Provider'}</span><strong>{strategy.name}</strong></div>
        <div className={aqua.rosterStatus}><span>{strategy.status}</span><code>{shortHash(strategy.strategyHash)}</code></div>
      </article>)}
    </section>

    <section className={aqua.activityPanel} aria-labelledby="mandate-activity-title">
      <div className={aqua.sectionTop}><h2 id="mandate-activity-title" className={aqua.sectionTitle}>Recent activity</h2><span className={aqua.muted}>{mandate.events.length} events</span></div>
      {mandate.events.length ? <ol className={aqua.activityList}>{mandate.events.map(event => <li key={event.id}><div><strong>{event.title}</strong><span>{event.detail}</span></div><div><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{event.explorerUrl && <a href={event.explorerUrl} target="_blank" rel="noreferrer">Transaction ↗</a>}</div></li>)}</ol> : <p className={aqua.muted}>Confirmed mandate activity will appear here.</p>}
    </section>

    <div className={aqua.evidence}><div><span>Confidential report</span><strong>{shortHash(mandate.evidence.reportDigest)}</strong></div><div><span>Aqua strategies</span><strong>{mandate.strategies.length} sharing one balance</strong></div><div><span>Currently authorized</span><strong>{active?.name ?? 'None'}</strong></div></div>
  </div>;
}
