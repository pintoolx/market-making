'use client';

import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { addMandateStrategy, createMandate, getExecutableStrategies, getMandate, type MandateState } from './mandateClient';
import { sealForConfidentialWorkflow } from './confidentialEnvelope';
import { readMandateReference, saveMandateReference } from './mandateReferenceStore';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { useProposals } from './proposalStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const STEPS = ['Choose a strategy', 'Set private limits', 'Review', 'Monitor'];
const FEATURED: Listing[] = [
  {
    id: 'featured-tight-market',
    name: 'Tight Market',
    summary: 'Concentrates WETH / USDC liquidity in a narrower range when price movement is contained.',
    template: AQUA_TEMPLATES[1],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
  },
  {
    id: 'featured-defensive-market',
    name: 'Defensive Market',
    summary: 'Uses a wider WETH / USDC range with lower fill and inventory caps when market risk increases.',
    template: AQUA_TEMPLATES[1],
    mine: false,
    provider: 'PinTool Strategies',
    providerAvatar: '/pintoolAvatar.svg',
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

type Phase = 'choose' | 'detail' | 'limits' | 'review' | 'submitting' | 'monitor';

const toNumber = (value: string) => Number(value.replace(/,/g, '').trim());
const positiveError = (value: string) => !value.trim() ? '' : !(toNumber(value) > 0) ? 'Enter an amount above 0.' : '';
const percentageError = (value: string) => {
  const n = toNumber(value);
  return !value.trim() ? '' : !(n > 0 && n <= 100) ? 'Enter a percentage between 1 and 100.' : '';
};
const validityError = (value: string) => {
  const n = toNumber(value);
  return !value.trim() ? '' : !Number.isInteger(n) || n < 1 || n > 10 ? 'Enter 1 to 10 whole minutes.' : '';
};
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const decimalToAtomic = (value: string, decimals: number): string => {
  const [whole, fraction = ''] = value.replace(/,/g, '').trim().split('.');
  const combined = `${whole}${(fraction + '0'.repeat(decimals)).slice(0, decimals)}`.replace(/^0+(?=\d)/, '');
  return combined || '0';
};
const percentageToBps = (value: string): number => Number(decimalToAtomic(value, 2));

export default function MakerFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const { published } = usePublishedListings();
  const { save } = useProposals();
  const [selected, setSelected] = useState<Listing[]>([]);
  const [budget, setBudget] = useState('20');
  const [exposure, setExposure] = useState('60');
  const [maxWethInventory, setMaxWethInventory] = useState('12');
  const [maxTrade, setMaxTrade] = useState('1');
  const [validityMinutes, setValidityMinutes] = useState('10');
  const [phase, setPhase] = useState<Phase>('choose');
  const [mandate, setMandate] = useState<MandateState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState('');
  const [executableCatalog, setExecutableCatalog] = useState<{ maker: string; ids: Set<string> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);
  const restoredMaker = useRef('');
  const openingLinkedStrategy = useRef(false);
  const makerAddress = account.addresses.find(address => executableCatalog?.maker === address.toLowerCase());

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [phase]);
  useEffect(() => {
    let current = true;
    getExecutableStrategies()
      .then(catalog => { if (current) setExecutableCatalog({ maker: catalog.maker.toLowerCase(), ids: new Set(catalog.strategies.map(item => item.id)) }); })
      .catch(() => { if (current) setExecutableCatalog({ maker: '', ids: new Set() }); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('strategy');
    if (!id) return;
    openingLinkedStrategy.current = true;
    const listing = [...readPublished(), ...FEATURED].find(item => item.id === id);
    if (listing) { setSelected([listing]); setPhase('detail'); }
    window.history.replaceState(null, '', '/maker');
  }, []);
  useEffect(() => {
    if (!makerAddress || restoredMaker.current === makerAddress.toLowerCase()
      || openingLinkedStrategy.current) return;
    restoredMaker.current = makerAddress.toLowerCase();
    const reference = readMandateReference(makerAddress);
    if (!reference) return;
    let current = true;
    setRefreshing(true);
    getMandate(reference.mandateId)
      .then(state => {
        if (!current || state.maker.toLowerCase() !== makerAddress.toLowerCase()) return;
        setMandate(state);
        setSelected([]);
        setPhase('monitor');
      })
      .catch(() => { /* Keep the marketplace usable while the service is unavailable. */ })
      .finally(() => { if (current) setRefreshing(false); });
    return () => { current = false; };
  }, [makerAddress]);

  const catalogMatchesWallet = !!makerAddress;
  const listings = [...published, ...FEATURED.filter(sample => !published.some(item => item.id === sample.id))]
    .map(item => ({ ...item, executionReady: catalogMatchesWallet && executableCatalog?.ids.has(item.id) }));
  const go = (next: Phase) => {
    didNavigate.current = true;
    scrollTop();
    setError('');
    setPhase(next);
  };
  const openStrategy = (listing: Listing) => { setSelected([listing]); go('detail'); };

  const valid = [budget, maxWethInventory, maxTrade].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
    && !!validityMinutes.trim() && !validityError(validityMinutes)
    && toNumber(maxWethInventory) <= toNumber(budget)
    && toNumber(maxTrade) <= toNumber(budget);

  const savePolicy = () => {
    if (!valid || selected.length === 0) return;
    go('review');
  };

  const submit = async () => {
    if (!makerAddress || selected.length === 0) {
      setError('Log in with the Maker wallet before creating the mandate.');
      return;
    }
    go('submitting');
    try {
      const publicKey = process.env.NEXT_PUBLIC_CONFIDENTIAL_WORKFLOW_PUBLIC_KEY?.trim();
      if (!publicKey) throw new Error('Confidential workflow encryption is not configured.');
      const makerLimitsEnvelope = sealForConfidentialWorkflow({
        schemaVersion: 2,
        maxBudget1: decimalToAtomic(budget, 6),
        maxToken0ShareBps: percentageToBps(exposure),
        maxToken0Value1: decimalToAtomic(maxWethInventory, 6),
        maxSwapValue1: decimalToAtomic(maxTrade, 6),
        maxTtlSec: Number(validityMinutes) * 60,
      }, publicKey, makerAddress);
      const state = await createMandate({
        maker: makerAddress,
        providerStrategyIds: selected.map(item => item.id),
        makerLimitsEnvelope,
      });
      setMandate(state);
      saveMandateReference(state.maker, state.mandateId);
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

  const addSelectedStrategy = async () => {
    if (!mandate || !selected[0]) return;
    go('submitting');
    try {
      const state = await addMandateStrategy(mandate.mandateId, selected[0].id);
      setMandate(state);
      saveMandateReference(state.maker, state.mandateId);
      setExpanding(false);
      go('monitor');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The strategy could not be added to this mandate.');
      setPhase('detail');
    }
  };
  const startAdding = () => { setExpanding(true); setSelected([]); go('choose'); };

  const previousStep = phase === 'detail'
    ? { phase: 'choose' as const, label: 'Strategy marketplace' }
    : phase === 'limits'
      ? { phase: 'detail' as const, label: 'Strategy details' }
      : phase === 'review'
        ? { phase: 'limits' as const, label: 'Private limits' }
        : null;

  const currentStep = ['choose', 'detail'].includes(phase) ? 0 : phase === 'limits' ? 1 : ['review', 'submitting'].includes(phase) ? 2 : 3;
  const title = phase === 'choose' ? expanding ? 'Add a strategy to your mandate.' : 'Find a strategy for your liquidity.'
    : phase === 'detail' ? selected[0]?.name ?? 'Strategy details.'
      : phase === 'limits' ? 'Set your capital boundaries.'
      : phase === 'review' ? 'Review your mandate.'
        : phase === 'submitting' ? 'Creating your mandate.'
          : 'Your liquidity mandate.';

  return <section className={aqua.flow}>
    {phase === 'choose' && expanding && <button type="button" className={aqua.backLink} onClick={() => { setExpanding(false); go('monitor'); }}>← Your mandate</button>}
    {previousStep && <button type="button" className={aqua.backLink} onClick={() => go(previousStep.phase)}>← {previousStep.label}</button>}
    <PageHead eyebrow="Maker Marketplace" title={title} accent={phase === 'monitor' ? 'One balance, guarded continuously.' : undefined} headingRef={heading}>
      {phase === 'choose' && (expanding ? 'Choose another compatible WETH / USDC strategy. Your existing private limits continue to apply.' : 'Explore strategies built for self-custodial liquidity on Aqua.')}
      {phase === 'detail' && 'Review what the strategy does, how it executes and what can go wrong before using it.'}
      {phase === 'limits' && 'The Provider never receives your original WETH exposure, inventory or fill limits.'}
      {phase === 'review' && 'The confidential workflow will check whether this strategy fits your private limits.'}
      {phase === 'submitting' && (expanding ? 'Checking the new strategy against your existing mandate and waiting for Guard confirmation.' : 'Checking Provider policies against your limits and waiting for the Guard report to be confirmed.')}
      {phase === 'monitor' && 'Track the currently authorized strategy and every confirmed execution decision.'}
    </PageHead>
    {!expanding && <Steps steps={STEPS} current={currentStep} />}
    {error && <div className={aqua.errorNotice} role="alert"><strong>Action required</strong><span>{error}</span></div>}

    {phase === 'choose' && <>
      <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Available strategies</h2><span className={aqua.muted}>{listings.length} strategies</span></div>
      <div className={`${styles.grid} ${aqua.grid}`}>
        {listings.filter(item => !expanding || !mandate?.strategies.some(strategy => strategy.listingId === item.id)).map(item => <ListingCard key={item.id} listing={item} action={<Secondary onClick={() => openStrategy(item)}>View strategy</Secondary>} />)}
      </div>
    </>}

    {phase === 'detail' && selected[0] && <StrategyDetail listing={{ ...selected[0], executionReady: catalogMatchesWallet && executableCatalog?.ids.has(selected[0].id) }} availabilityKnown={executableCatalog !== null && !!account.address} actionLabel={expanding ? 'Add to mandate' : 'Use this strategy'} onUse={expanding ? addSelectedStrategy : () => go('limits')} />}

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private mandate</legend>
          <p className={aqua.muted}>These limits govern this mandate, including compatible strategies you add later.</p>
          <label>Capital budget (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={event => setBudget(event.target.value)} /></label>
          <label>Maximum WETH exposure (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={event => setExposure(event.target.value)} /></label>
          <label>Maximum WETH inventory (USDC value)<FormInput inputMode="decimal" value={maxWethInventory} aria-invalid={!!positiveError(maxWethInventory) || toNumber(maxWethInventory) > toNumber(budget)} onChange={event => setMaxWethInventory(event.target.value)} /></label>
          <label>Maximum amount per swap (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={event => setMaxTrade(event.target.value)} /></label>
          <label>Mandate validity (minutes)<FormInput inputMode="numeric" value={validityMinutes} aria-invalid={!!validityError(validityMinutes)} onChange={event => setValidityMinutes(event.target.value)} /><span className={validityError(validityMinutes) ? aqua.fieldError : aqua.hint}>{validityError(validityMinutes) || 'Trading stops when the latest authorization expires.'}</span></label>
        </fieldset>
        <Primary type="submit" disabled={!valid}>Review mandate</Primary>
      </form>
      <aside className={aqua.explanation}><h2>Your limits remain in control</h2><ul className={aqua.trustList}><li>Funds remain in your Maker wallet.</li><li>The Provider policy may narrow your limits, never expand them.</li><li>You can add other compatible strategies after activation.</li></ul><h3>Execution pair</h3><p>WETH / USDC</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <StrategySet selected={selected} />
        <PolicyMetrics budget={budget} exposure={exposure} maxWethInventory={maxWethInventory} maxTrade={maxTrade} validity={validityMinutes} />
        <div className={aqua.actionRow}><Primary onClick={submit}>Create confidential mandate</Primary><Secondary onClick={() => go('limits')}>Edit limits</Secondary></div>
      </div>
      <PrivacyRoute />
    </div>}

    {phase === 'submitting' && <RuntimePanel expanding={expanding} />}
    {phase === 'monitor' && mandate && <MandateMonitor mandate={mandate} refreshing={refreshing} onRefresh={refresh} onAdd={startAdding} />}
  </section>;
}

function StrategySet({ selected }: { selected: Listing[] }) {
  return <div className={aqua.providerPair}>{selected.map(item => <div key={item.id}><span>{item.provider ?? 'Independent Provider'}</span><strong>{item.name}</strong><small>{item.template.label}</small></div>)}</div>;
}

function StrategyDetail({ listing, availabilityKnown, actionLabel, onUse }: { listing: Listing; availabilityKnown: boolean; actionLabel: string; onUse: () => void }) {
  return <div className={aqua.decisionGrid}>
    <div className={aqua.previewColumn}>
      <ListingCard listing={listing} />
      <Primary disabled={!listing.executionReady} onClick={onUse}>{!availabilityKnown ? 'Checking availability' : listing.executionReady ? actionLabel : 'Not accepting liquidity'}</Primary>
      {availabilityKnown && !listing.executionReady && <p className={aqua.muted}>This Provider is not currently accepting new liquidity for this strategy.</p>}
    </div>
    <aside className={aqua.explanation}>
      <span className={aqua.eyebrow}>Strategy specifications</span>
      <h2>Liquidity configuration</h2>
      <div className={aqua.intentRows}>
        <div><span>Pair</span><strong>WETH / USDC</strong></div>
        <div><span>Mechanism</span><strong>{listing.template.mechanism}</strong></div>
        <div><span>Custody</span><strong>Maker wallet</strong></div>
        <div><span>Provider policy</span><strong>{listing.template.privateInputs}</strong></div>
      </div>
      <h3>Risk to understand</h3>
      <p>{listing.template.risk}</p>
      <p className={aqua.muted}>Reviewing a strategy does not reveal its Provider&apos;s private policy. Your own limits are applied before it can be authorized.</p>
    </aside>
  </div>;
}

function PolicyMetrics({ budget, exposure, maxWethInventory, maxTrade, validity }: { budget: string; exposure: string; maxWethInventory: string; maxTrade: string; validity: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>WETH exposure</span><strong>{exposure}% max</strong></div><div><span>WETH inventory</span><strong>{maxWethInventory} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Authorization validity</span><strong>{validity} minutes</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>Disclosure boundary</span><h2>Only the mandate leaves the TEE.</h2><div><span>Provider policies</span><strong>Confidential</strong></div><div><span>Maker limits</span><strong>Confidential</strong></div><div><span>Authorization</span><strong>Public and enforceable</strong></div></aside>;
}

function RuntimePanel({ expanding }: { expanding: boolean }) {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>Chainlink Confidential Workflow</span><h2>{expanding ? 'Adding strategy to mandate' : 'Evaluating your strategy'}</h2><p>Applying your hard limits and waiting for the resulting PinTool Guard state to be confirmed onchain.</p></div><ol className={aqua.runtimeSteps}><li data-done>{expanding ? 'New strategy received' : 'Strategy received'}</li><li data-done>Maker mandate received</li><li data-active>Private policies being evaluated</li><li>Guard confirmation</li></ol></div>;
}

function MandateMonitor({ mandate, refreshing, onRefresh, onAdd }: { mandate: MandateState; refreshing: boolean; onRefresh: () => void; onAdd: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const fresh = (item: MandateState['strategies'][number]) => !!item.readiness?.validUntil && Date.parse(item.readiness.validUntil) > now;
  const active = mandate.strategies.find(item => fresh(item) && item.readiness?.authorized);
  const expires = new Date(mandate.evidence.expiresAt);
  return <div className={aqua.monitorLayout}>
    <section className={aqua.panel}>
      <div className={aqua.statusHeader}><span className={aqua.statusMark}>✓</span><div><span className={aqua.eyebrow}>Mandate sequence {mandate.evidence.sequence}</span><h2>{active ? active.name : 'No strategy currently authorized'}</h2></div></div>
      <div className={aqua.intentRows}><div><span>Market state</span><strong>{mandate.regime === 'high-volatility' ? 'High volatility' : mandate.regime === 'normal' ? 'Normal' : 'Evaluating'}</strong></div><div><span>Pair</span><strong>WETH / USDC</strong></div><div><span>Network</span><strong>{mandate.evidence.networkName}</strong></div><div><span>Authorization expires</span><strong>{Number.isNaN(expires.valueOf()) ? mandate.evidence.expiresAt : expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></div></div>
      <div className={aqua.actionRow}><Primary onClick={onAdd}>Add strategy</Primary><Secondary disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh status'}</Secondary></div>
      <a className={aqua.evidenceLink} href={mandate.evidence.reportExplorerUrl} target="_blank" rel="noreferrer">View Guard update ↗</a>
    </section>

    <section className={aqua.strategyRoster} aria-labelledby="strategy-roster-title">
      <div className={aqua.sectionTop}><h2 id="strategy-roster-title" className={aqua.sectionTitle}>Strategy set</h2><span className={aqua.muted}>One shared balance</span></div>
      {mandate.strategies.map(strategy => <article key={strategy.listingId} className={aqua.rosterRow} data-status={strategy.status}>
        <div><span className={aqua.eyebrow}>{strategy.provider ?? 'Strategy Provider'}</span><strong>{strategy.name}</strong></div>
        <div className={aqua.rosterStatus}>
          <span>{!fresh(strategy) ? 'Refresh to verify' : strategy.readiness?.phase === 'ready-for-quote' ? 'Ready to quote' : 'Not ready to quote'}</span>
          <small>Guard: {fresh(strategy) && strategy.readiness?.authorized ? 'authorized' : 'unverified / inactive'} · Aqua: {fresh(strategy) && strategy.readiness?.shipped ? 'shipped' : 'unverified / unavailable'} · Funds: {fresh(strategy) && strategy.readiness?.funded ? 'checked' : 'unverified / insufficient'}</small>
          <code>{shortHash(strategy.strategyHash)}</code>
        </div>
      </article>)}
    </section>

    <section className={aqua.activityPanel} aria-labelledby="mandate-activity-title">
      <div className={aqua.sectionTop}><h2 id="mandate-activity-title" className={aqua.sectionTitle}>Recent activity</h2><span className={aqua.muted}>{mandate.events.length} events</span></div>
      {mandate.events.length ? <ol className={aqua.activityList}>{mandate.events.map(event => <li key={event.id}><div><strong>{event.title}</strong><span>{event.detail}</span></div><div><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{event.explorerUrl && <a href={event.explorerUrl} target="_blank" rel="noreferrer">Transaction ↗</a>}</div></li>)}</ol> : <p className={aqua.muted}>Confirmed mandate activity will appear here.</p>}
    </section>

    <p className={aqua.muted}>Readiness is a short-lived chain snapshot. Each trade still requires a fresh quote and Guard checks. A saved listing or accepted report alone does not mean liquidity can trade.</p>
    <div className={aqua.evidence}><div><span>Guard report</span><strong>{shortHash(mandate.evidence.reportDigest)}</strong></div><div><span>Aqua strategies</span><strong>{mandate.strategies.length} sharing one balance</strong></div><div><span>Currently authorized</span><strong>{active?.name ?? 'Unverified / none'}</strong></div></div>
  </div>;
}
