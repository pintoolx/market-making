'use client';

import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { createMandate, getExecutableStrategies, getMandate, reevaluateExecutionProfile, request, type MandateState } from './mandateClient';
import type { PublicRelease } from './ClmmPublisher';
import { CONFIDENTIAL_WORKFLOW_PUBLIC_KEY, sealForConfidentialWorkflow } from './confidentialEnvelope';
import { ADAPTIVE_PROFILE_IDS, presentMandate } from './mandatePresentation';

import { readMandateReference, saveMandateReference } from './mandateReferenceStore';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { useProposals } from './proposalStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const STEPS = ['Choose a strategy', 'Set private limits', 'Review', 'Monitor'];
const FEATURED: Listing[] = [
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

type Phase = 'choose' | 'detail' | 'limits' | 'review' | 'submitting' | 'monitor';

const toNumber = (value: string) => Number(value.replace(/,/g, '').trim());
const positiveError = (value: string) => !value.trim() ? '' : !(toNumber(value) > 0) ? 'Enter an amount above 0.' : '';
const percentageError = (value: string) => {
  const n = toNumber(value);
  return !value.trim() ? '' : !(n > 0 && n <= 100) ? 'Enter a percentage between 1 and 100.' : '';
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
  const [phase, setPhase] = useState<Phase>('choose');
  const [mandate, setMandate] = useState<MandateState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [error, setError] = useState('');
  const [executableCatalog, setExecutableCatalog] = useState<{ maker: string; ids: Set<string> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);
  const restoredMaker = useRef('');
  const openingLinkedStrategy = useRef(false);
  const linkedStrategyId = useRef<string | null | undefined>(undefined);
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
    if (linkedStrategyId.current === undefined) linkedStrategyId.current = new URLSearchParams(window.location.search).get('strategy');
    const id = linkedStrategyId.current;
    if (!id) return;
    let current = true;
    openingLinkedStrategy.current = true;
    const listing = [...readPublished(), ...FEATURED].find(item => item.id === id);
    if (listing) { setSelected([listing]); setPhase('detail'); }
    else {
      const version = id.match(/^([0-9a-f]{40}-clmm)\.v([1-9][0-9]{0,6})$/);
      if (version) void request<PublicRelease>(`/v1/provider-strategies/${version[1]}/versions/${version[2]}`).then(release => {
        if (!current) return;
        if (release.id !== version[1] || release.version !== Number(version[2])) throw new Error('Publication version mismatch.');
        setSelected([{ id, releaseId: release.id, version: release.version, name: release.name, summary: release.summary,
          template: AQUA_TEMPLATES[1], provider: release.provider, feePct: 0, mine: false }]);
        setPhase('detail');
      }).catch(() => { if (current) setError('This publication version could not be loaded.'); });
    }
    window.history.replaceState(null, '', '/maker');
    return () => { current = false; };
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
  const isExecutable = (item: Listing) => {
    const ids = item.executionProfileIds ?? [item.id];
    return catalogMatchesWallet && ids.every(id => executableCatalog?.ids.has(id));
  };
  const listings = [...published, ...FEATURED.filter(sample => !published.some(item => item.id === sample.id))]
    .map(item => ({ ...item, executionReady: isExecutable(item) }));
  const go = (next: Phase) => {
    didNavigate.current = true;
    scrollTop();
    setError('');
    setPhase(next);
  };
  const openStrategy = (listing: Listing) => { setSelected([listing]); go('detail'); };

  const valid = [budget, maxWethInventory, maxTrade].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
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
      const makerLimitsEnvelope = sealForConfidentialWorkflow({
        schemaVersion: 3,
        maxBudget1: decimalToAtomic(budget, 6),
        maxToken0ShareBps: percentageToBps(exposure),
        maxToken0Value1: decimalToAtomic(maxWethInventory, 6),
        maxSwapValue1: decimalToAtomic(maxTrade, 6),
        authorization: 'until-changed',
      }, CONFIDENTIAL_WORKFLOW_PUBLIC_KEY, makerAddress);
      const state = await createMandate({
        maker: makerAddress,
        // An adaptive listing is one product whose first provisioned profile is
        // evaluated at activation. Later evaluations can authorize another
        // profile without asking the Maker to buy a second strategy.
        providerStrategyIds: selected.flatMap(item => item.executionProfileIds?.slice(0, 1) ?? [item.id]),
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
        authorization: 'until-changed',
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

  const reevaluate = async (profileId?: string) => {
    if (!mandate) return;
    const active = mandate.strategies.find(item => item.status === 'active');
    const lastEvaluated = mandate.strategies.at(-1)?.listingId;
    const current = active?.listingId ?? lastEvaluated;
    const target = profileId ?? current ?? ADAPTIVE_PROFILE_IDS[0];
    setReevaluating(true);
    go('submitting');
    try {
      const state = await reevaluateExecutionProfile(mandate.mandateId, target);
      setMandate(state);
      saveMandateReference(state.maker, state.mandateId);
      go('monitor');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The strategy could not be re-evaluated.');
      setPhase('monitor');
    } finally {
      setReevaluating(false);
    }
  };

  const previousStep = phase === 'detail'
    ? { phase: 'choose' as const, label: 'Strategy marketplace' }
    : phase === 'limits'
      ? { phase: 'detail' as const, label: 'Strategy details' }
      : phase === 'review'
        ? { phase: 'limits' as const, label: 'Private limits' }
        : phase === 'monitor' ? { phase: 'choose' as const, label: 'Strategy marketplace' } : null;

  const currentStep = ['choose', 'detail'].includes(phase) ? 0 : phase === 'limits' ? 1 : ['review', 'submitting'].includes(phase) ? 2 : 3;
  const title = phase === 'choose' ? 'Find a strategy for your liquidity.'
    : phase === 'detail' ? selected[0]?.name ?? 'Strategy details.'
      : phase === 'limits' ? 'Set your capital boundaries.'
      : phase === 'review' ? 'Review your mandate.'
        : phase === 'submitting' ? reevaluating ? 'Re-evaluating execution.' : 'Creating your mandate.'
          : 'Your liquidity mandate.';

  return <section className={aqua.flow}>
    {previousStep && <button type="button" className={aqua.backLink} onClick={() => go(previousStep.phase)}>← {previousStep.label}</button>}
    <PageHead eyebrow="Maker Marketplace" title={title} accent={phase === 'monitor' ? 'One balance, guarded continuously.' : undefined} headingRef={heading}>
      {phase === 'choose' && 'Explore strategies built for self-custodial liquidity on Aqua.'}
      {phase === 'detail' && 'Review what the strategy does, how it executes and what can go wrong before using it.'}
      {phase === 'limits' && 'The Provider never receives your original WETH exposure, inventory or fill limits.'}
      {phase === 'review' && 'The confidential workflow will check whether this strategy fits your private limits.'}
      {phase === 'submitting' && (reevaluating ? 'Re-evaluating the strategy against current conditions and your existing mandate.' : 'Checking Provider policies against your limits and waiting for the Guard report to be confirmed.')}
      {phase === 'monitor' && 'Track the current execution profile and every confirmed authorization or trade.'}
    </PageHead>
    <Steps steps={STEPS} current={currentStep} />
    {error && <div className={aqua.errorNotice} role="alert"><strong>Action required</strong><span>{error}</span></div>}

    {phase === 'choose' && <>
      {mandate && <Secondary onClick={() => { go('monitor'); void refresh(); }}>View current mandate</Secondary>}
      <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Available strategies</h2><span className={aqua.muted}>{listings.length} strategies</span></div>
      <div className={`${styles.grid} ${aqua.grid}`}>
        {listings.map(item => <ListingCard key={item.id} listing={item} action={<Secondary onClick={() => openStrategy(item)}>View strategy</Secondary>} />)}
      </div>
    </>}

    {phase === 'detail' && selected[0] && <StrategyDetail listing={{ ...selected[0], executionReady: isExecutable(selected[0]) }} availabilityKnown={executableCatalog !== null && !!account.address} actionLabel="Use this strategy" onUse={() => go('limits')} />}

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private mandate</legend>
          <p className={aqua.muted}>These limits govern every execution profile produced by this strategy.</p>
          <label>Capital budget (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={event => setBudget(event.target.value)} /></label>
          <label>Maximum WETH exposure (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={event => setExposure(event.target.value)} /></label>
          <label>Maximum WETH inventory (USDC value)<FormInput inputMode="decimal" value={maxWethInventory} aria-invalid={!!positiveError(maxWethInventory) || toNumber(maxWethInventory) > toNumber(budget)} onChange={event => setMaxWethInventory(event.target.value)} /></label>
          <label>Maximum amount per swap (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={event => setMaxTrade(event.target.value)} /></label>
          <p className={aqua.hint}>Your authorization stays in effect until changed or revoked. New execution conditions require a confirmed Guard update.</p>
        </fieldset>
        <Primary type="submit" disabled={!valid}>Review mandate</Primary>
      </form>
      <aside className={aqua.explanation}><h2>Your limits remain in control</h2><ul className={aqua.trustList}><li>Funds remain in your Maker wallet.</li><li>The Provider policy may narrow your limits, never expand them.</li><li>Every execution profile inherits the same mandate.</li></ul><h3>Execution pair</h3><p>WETH / USDC</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <StrategySet selected={selected} />
        <PolicyMetrics budget={budget} exposure={exposure} maxWethInventory={maxWethInventory} maxTrade={maxTrade} />
        <div className={aqua.actionRow}><Primary onClick={submit}>Create confidential mandate</Primary><Secondary onClick={() => go('limits')}>Edit limits</Secondary></div>
      </div>
      <PrivacyRoute />
    </div>}

    {phase === 'submitting' && <RuntimePanel reevaluating={reevaluating} />}
    {phase === 'monitor' && mandate && <MandateMonitor mandate={mandate} refreshing={refreshing} reevaluating={reevaluating} onRefresh={refresh} onReevaluate={reevaluate} onEdit={() => {
      const strategy = mandate.strategies.find(item => item.status === 'active') ?? mandate.strategies[0];
      const listing = listings.find(item => (item.executionProfileIds ?? [item.id]).includes(strategy.listingId));
      // A published version may no longer be the latest listing. Preserve its
      // identity; never replace it with the featured strategy when editing.
      setSelected([listing ?? { id: strategy.listingId, name: strategy.name, provider: strategy.provider,
        summary: 'Your selected strategy version.', template: AQUA_TEMPLATES[1], mine: false }]);
      go('limits');
    }} />}
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
        {listing.executionProfileIds && <div><span>Execution profiles</span><strong>Tight · Defensive · Paused</strong></div>}
      </div>
      <h3>Risk to understand</h3>
      <p>{listing.template.risk}</p>
      <p className={aqua.muted}>Reviewing a strategy does not reveal its Provider&apos;s private policy. Your own limits are applied before it can be authorized.</p>
    </aside>
  </div>;
}

function PolicyMetrics({ budget, exposure, maxWethInventory, maxTrade }: { budget: string; exposure: string; maxWethInventory: string; maxTrade: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>WETH exposure</span><strong>{exposure}% max</strong></div><div><span>WETH inventory</span><strong>{maxWethInventory} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Authorization</span><strong>Until changed or revoked</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>Disclosure boundary</span><h2>Only an execution authorization leaves the TEE.</h2><div><span>Provider policies</span><strong>Confidential</strong></div><div><span>Maker limits</span><strong>Confidential</strong></div><div><span>Authorization</span><strong>Public and enforceable</strong></div></aside>;
}

function RuntimePanel({ reevaluating }: { reevaluating: boolean }) {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>Chainlink Confidential Workflow</span><h2>{reevaluating ? 'Re-evaluating execution' : 'Evaluating your strategy'}</h2><p>Applying your hard limits and waiting for the resulting PinTool Guard state to be confirmed onchain.</p></div><ol className={aqua.runtimeSteps}><li data-done>Strategy policy received</li><li data-done>Maker mandate received</li><li data-active>Private policies being evaluated</li><li>Guard confirmation</li></ol></div>;
}

function MandateMonitor({ mandate, refreshing, reevaluating, onRefresh, onReevaluate, onEdit }: { mandate: MandateState; refreshing: boolean; reevaluating: boolean; onRefresh: () => void; onReevaluate: (profileId?: string) => void; onEdit: () => void }) {
  // Keep the server render deterministic. Browser-local timestamps are filled
  // after hydration, avoiding locale and clock differences in the initial HTML.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const fresh = (item: Pick<MandateState['strategies'][number], 'readiness'>) => !!item.readiness?.validUntil && Date.parse(item.readiness.validUntil) > now;
  const authorizationCurrent = now > 0 && (mandate.evidence.expiresAt === null || Date.parse(mandate.evidence.expiresAt) > now);
  const active = authorizationCurrent ? mandate.strategies.find(item => fresh(item) && item.readiness?.authorized) : undefined;
  const verified = now > 0 && mandate.strategies.every(fresh);
  const { name, adaptive, profiles, profileName } = presentMandate(mandate.strategies);
  return <div className={aqua.monitorLayout}>
    <section className={aqua.panel}>
      <div className={aqua.statusHeader}><span className={aqua.statusMark}>{active ? '✓' : '·'}</span><div><span className={aqua.eyebrow}>Report nonce {mandate.evidence.sequence}</span><h2>{name}</h2></div></div>
      <div className={aqua.intentRows}><div><span>Current profile</span><strong>{now === 0 ? 'Checking…' : active ? profileName(active.listingId) : verified ? 'Paused' : 'Refresh to verify'}</strong></div><div><span>Pair</span><strong>WETH / USDC</strong></div><div><span>Network</span><strong>{mandate.evidence.networkName}</strong></div><div><span>Authorization</span><strong>{mandate.evidence.expiresAt === null ? 'Until changed or revoked' : 'Update limits to continue'}</strong></div></div>
      <div className={aqua.actionRow}><Primary disabled={reevaluating} onClick={() => onReevaluate()}>{reevaluating ? 'Evaluating…' : 'Re-evaluate strategy'}</Primary><Secondary disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh status'}</Secondary><Secondary disabled={reevaluating} onClick={onEdit}>Update limits</Secondary></div>
    </section>

    <section className={aqua.strategyRoster} aria-labelledby="strategy-roster-title">
      <div className={aqua.sectionTop}><h2 id="strategy-roster-title" className={aqua.sectionTitle}>Execution profiles</h2><span className={aqua.muted}>{adaptive ? 'One strategy · one shared balance' : 'Self-custodial liquidity'}</span></div>
      {profiles.map(strategy => <article key={strategy.listingId} className={aqua.rosterRow} data-status={strategy.status}>
        <div><span className={aqua.eyebrow}>{adaptive ? name : strategy.provider ?? 'Independent Provider'}</span><strong>{strategy.name}</strong></div>
        <div className={aqua.rosterStatus}>
          <span>{'readiness' in strategy && fresh(strategy) ? strategy.readiness?.authorized ? 'Active' : strategy.status === 'paused' ? 'Paused' : 'Standby' : 'Refresh to verify'}</span>
          {'readiness' in strategy && <small>Guard: {!fresh(strategy) ? 'not verified' : strategy.readiness?.authorized ? 'authorized' : 'inactive'} · Aqua: {fresh(strategy) && strategy.readiness?.shipped ? 'shipped' : 'not verified'} · Funds: {fresh(strategy) && strategy.readiness?.funded ? 'checked' : 'not verified'}</small>}
          {strategy.strategyHash && <CopyStrategyHash value={strategy.strategyHash} />}
          <Secondary disabled={reevaluating} onClick={() => onReevaluate(strategy.listingId)}>Evaluate profile</Secondary>
        </div>
      </article>)}
    </section>

    <section className={aqua.activityPanel} aria-labelledby="mandate-activity-title">
      <div className={aqua.sectionTop}><h2 id="mandate-activity-title" className={aqua.sectionTitle}>Recent activity</h2><span className={aqua.muted}>{mandate.events.length} events</span></div>
      {mandate.events.length ? <ol className={aqua.activityList}>{mandate.events.map(event => <li key={event.id}><div><strong>{event.title.replace('Tight Market', 'Tight profile').replace('Defensive Market', 'Defensive profile')}</strong><span>{event.detail}</span></div><div><time dateTime={event.occurredAt}>{now === 0 ? '—' : new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{event.explorerUrl && <a href={event.explorerUrl} target="_blank" rel="noreferrer">Transaction ↗</a>}</div></li>)}</ol> : <p className={aqua.muted}>Confirmed mandate activity will appear here.</p>}
    </section>

    <p className={aqua.muted}>Readiness is a short-lived chain snapshot. Each trade still requires a fresh quote and Guard checks. A saved listing or accepted report alone does not mean liquidity can trade.</p>
    <div className={aqua.evidence}><div><span>Guard transaction</span><a className={aqua.evidenceValue} href={mandate.evidence.reportExplorerUrl} target="_blank" rel="noreferrer" aria-label={`View Guard transaction ${mandate.evidence.reportTransactionHash} on Etherscan`}><code>{shortHash(mandate.evidence.reportTransactionHash)}</code><b>View ↗</b></a></div><div><span>Aqua execution</span><strong>{profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'} · one Maker balance</strong></div><div><span>Current profile</span><strong>{now === 0 ? 'Checking…' : active ? profileName(active.listingId) : verified ? 'Paused' : 'Refresh to verify'}</strong></div></div>
  </div>;
}

function CopyStrategyHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard access can be blocked by the browser. */ }
  };
  return <button type="button" className={aqua.hashCopy} onClick={copy} title={value} aria-label={copied ? 'Strategy ID copied' : `Copy strategy ID ${value}`}><code>{shortHash(value)}</code><small>{copied ? 'Copied' : 'Copy'}</small></button>;
}
