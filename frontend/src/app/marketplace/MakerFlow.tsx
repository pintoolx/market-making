'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { createMandate, getExecutableStrategies, getMandate, reevaluateExecutionProfile, type MandateState } from './mandateClient';
import { CONFIDENTIAL_WORKFLOW_PUBLIC_KEY, sealForConfidentialWorkflow } from './confidentialEnvelope';
import { ADAPTIVE_PROFILE_IDS, presentMandate } from './mandatePresentation';

import { saveMandateReference } from './mandateReferenceStore';
import { usePublishedListings, type Listing } from './publishedStore';
import { ListingCard, ListingGrid, PageHead, Steps } from './ui';
import aqua from './aqua.module.css';
import { discoverStrategyNames } from '../ens/strategyNames';
import { FEATURED } from './featuredStrategies';
import { loadStrategyListing } from './strategyCatalog';
import { strategyHref, restoreMarketplaceScroll, consumeMarketplaceReturn } from './strategyLinks';
import StrategyLink from './StrategyLink';
import ProviderIdentity from './ProviderIdentity';
import MakerActivation from './MakerActivation';

const STEPS = ['Choose a strategy', 'Set up liquidity', 'Review', 'Monitor'];

type Phase = 'choose' | 'detail' | 'activate' | 'limits' | 'review' | 'submitting' | 'monitor';

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
  const router = useRouter();
  const params = useSearchParams();
  const linkedId = params.get('strategy');
  const linkedEns = params.get('ens');
  const linkedMandateId = params.get('mandate');
  const start = params.get('start') === '1';
  const [loadingLinked, setLoadingLinked] = useState(false);
  const { published } = usePublishedListings();
  const [selected, setSelected] = useState<Listing[]>([]);
  const [budget, setBudget] = useState('20');
  const [exposure, setExposure] = useState('60');
  const [maxWethInventory, setMaxWethInventory] = useState('12');
  const [maxTrade, setMaxTrade] = useState('1');
  const [phase, setPhase] = useState<Phase>('choose');
  const [editingExisting, setEditingExisting] = useState(false);
  const [mandate, setMandate] = useState<MandateState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [error, setError] = useState('');
  const [executableCatalog, setExecutableCatalog] = useState<{ maker: string; ids: Set<string> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);
  const restoredMaker = useRef('');
  const openingLinkedStrategy = useRef(false);
  const lastLinkedStrategy = useRef<string | null>(null);
  const accountWalletKey = account.addresses.map(address => address.toLowerCase()).sort().join(',');
  const makerAddress = account.addresses.find(address => executableCatalog?.maker === address.toLowerCase());
  const setupMakerAddress = editingExisting && mandate
    ? account.addresses.find(address => address.toLowerCase() === mandate.maker.toLowerCase())
    : makerAddress;

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [phase]);
  useEffect(() => { consumeMarketplaceReturn(); }, []);
  useEffect(() => {
    let current = true;
    if (!makerAddress) {
      setExecutableCatalog({ maker: '', ids: new Set() });
      return;
    }
    getExecutableStrategies(makerAddress)
      .then(catalog => { if (current) setExecutableCatalog({ maker: catalog.maker?.toLowerCase() ?? makerAddress, ids: new Set(catalog.strategies.map(item => item.id)) }); })
      .catch(() => { if (current) setExecutableCatalog({ maker: '', ids: new Set() }); });
    return () => { current = false; };
  }, [makerAddress]);
  useEffect(() => {
    openingLinkedStrategy.current = !!(linkedId || linkedEns);
    if (!linkedId) {
      if (lastLinkedStrategy.current) { setPhase('choose'); setSelected([]); setError(''); setLoadingLinked(false); }
      lastLinkedStrategy.current = null;
      return;
    }
    lastLinkedStrategy.current = linkedId;
    if (!start) { router.replace(strategyHref(linkedId, linkedEns ?? undefined)); return; }
    let current = true;
    setLoadingLinked(true); setSelected([]); setError('');
    const load = async () => {
      const [listing, catalog] = await Promise.all([loadStrategyListing(linkedId), getExecutableStrategies(makerAddress)]);
      const names = await discoverStrategyNames(listing, linkedEns ?? undefined);
      if (linkedEns && !names.ensSelection) throw new Error('The ENS entry no longer points to this version. Open the strategy details again to review it.');
      const ids = new Set(catalog.strategies.map(item => item.id));
      const executable = (listing.executionProfileIds ?? [listing.id]).every(id => ids.has(id));
      if (!executable && !listing.releaseId) throw new Error('This strategy is not available for activation.');
      if (!current) return;
      setExecutableCatalog({ maker: catalog.maker?.toLowerCase() ?? '', ids });
      setSelected([{ ...listing, ...names }]);
      setPhase(executable ? 'limits' : 'activate');
    };
    load().catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'This strategy could not be loaded.'); })
      .finally(() => { if (current) setLoadingLinked(false); });
    return () => { current = false; };
  }, [linkedId, linkedEns, start, router]);
  useEffect(() => {
    if (phase !== 'choose' || linkedId) return;
    const frame = requestAnimationFrame(restoreMarketplaceScroll);
    return () => cancelAnimationFrame(frame);
  }, [phase, published.length, linkedId]);
  useEffect(() => {
    // Browsing Liquidity never opts into restoring a previous execution session.
    if (!linkedMandateId) {
      restoredMaker.current = '';
      setMandate(null);
      setEditingExisting(false);
      setRefreshing(false);
      if (!linkedId) setPhase('choose');
      return;
    }
    const restoreKey = `${accountWalletKey}:${linkedMandateId ?? ''}`;
    if (!account.ready || !account.authenticated || !accountWalletKey) {
      restoredMaker.current = '';
      setMandate(null);
      setPhase('choose');
      return;
    }
    if (restoredMaker.current === restoreKey || openingLinkedStrategy.current) return;
    if (linkedMandateId && !/^mandate-[a-f0-9-]{36}$/.test(linkedMandateId)) {
      setError('This liquidity link is invalid.'); return;
    }
    let current = true;
    setRefreshing(true);
    getMandate(linkedMandateId)
      .then(state => {
        if (!current || openingLinkedStrategy.current) return;
        if (!accountWalletKey.split(',').includes(state.maker.toLowerCase())) throw new Error('This liquidity setup belongs to a wallet that is not linked to this account.');
        restoredMaker.current = restoreKey;
        saveMandateReference(state.maker, state.mandateId);
        setError('');
        setMandate(state);
        setSelected([]);
        setPhase('monitor');
      })
      .catch(reason => { if (current && linkedMandateId) setError(reason instanceof Error ? reason.message : 'Unable to open this liquidity setup. Reload and try again.'); })
      .finally(() => { if (current) setRefreshing(false); });
    return () => { current = false; };
  }, [account.ready, account.authenticated, accountWalletKey, linkedMandateId, linkedId]);

  const catalogMatchesWallet = !!makerAddress;
  const isExecutable = (item: Listing) => {
    const ids = item.executionProfileIds ?? [item.id];
    return catalogMatchesWallet && ids.every(id => executableCatalog?.ids.has(id));
  };
  const listings = [...published, ...FEATURED.filter(sample => !published.some(item => item.id === sample.id))]
    .map(item => ({ ...item, executionReady: isExecutable(item) }));
  const go = (next: Phase) => {
    if (next === 'detail' && selected[0]) { router.push(strategyHref(selected[0].id, selected[0].ensName)); return; }
    if (next === 'monitor') setEditingExisting(false);
    if (next === 'choose') {
      restoredMaker.current = '';
      if (linkedId || linkedMandateId) router.push('/maker');
    }
    didNavigate.current = true;
    scrollTop();
    setError('');
    setPhase(next);
  };

  const valid = [budget, maxWethInventory, maxTrade].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
    && toNumber(maxWethInventory) <= toNumber(budget)
    && toNumber(maxTrade) <= toNumber(budget);

  const savePolicy = () => {
    if (!valid || selected.length === 0) return;
    go('review');
  };

  const submit = async () => {
    if (!setupMakerAddress || selected.length === 0) {
      setError('Connect the wallet that will provide liquidity before continuing.');
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
      }, CONFIDENTIAL_WORKFLOW_PUBLIC_KEY, setupMakerAddress);
      const state = await createMandate({
        maker: setupMakerAddress,
        // An adaptive listing is one product whose first provisioned profile is
        // evaluated at activation. Later evaluations can authorize another
        // profile without asking the Maker to buy a second strategy.
        providerStrategyIds: selected.flatMap(item => item.executionProfileIds?.slice(0, 1) ?? [item.id]),
        makerLimitsEnvelope,
        ensSelections: selected.flatMap(item => item.ensSelection ? [item.ensSelection] : []),
      });
      setMandate(state);
      saveMandateReference(state.maker, state.mandateId);
      router.replace(`/maker?mandate=${encodeURIComponent(state.mandateId)}`);
      go('monitor');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your liquidity setup could not be created.');
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
      setError(reason instanceof Error ? reason.message : 'Your liquidity status could not be refreshed.');
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
  const editLimits = () => {
    if (!mandate) return;
    setEditingExisting(true);
    const strategy = mandate.strategies.find(item => item.status === 'active') ?? mandate.strategies[0];
    if (!strategy) { go('choose'); return; }
    const listing = listings.find(item => (item.executionProfileIds ?? [item.id]).includes(strategy.listingId));
    const pin = mandate.ensSelections?.find(item => `${item.pointer.releaseId}.v${item.pointer.version}` === strategy.listingId);
    if (pin) {
      const { name, node, pointer } = pin;
      setSelected([{ ...listing, id: strategy.listingId, name: strategy.name,
        summary: listing?.summary ?? `Strategy published as ${name}.`, template: AQUA_TEMPLATES[1], mine: false,
        releaseId: pointer.releaseId, version: pointer.version, provider: pointer.provider, ensSelection: { name, node, pointer } }]);
    } else setSelected([listing ?? { id: strategy.listingId, name: strategy.name, provider: strategy.provider,
      summary: 'Your selected strategy version.', template: AQUA_TEMPLATES[1], mine: false }]);
    go('limits');
  };

  const previousStep = phase === 'activate' ? { phase: 'detail' as const, label: 'Strategy details' } : phase === 'detail'
    ? { phase: 'choose' as const, label: 'Strategy marketplace' }
    : phase === 'limits'
      ? editingExisting ? { phase: 'monitor' as const, label: 'Liquidity overview' } : { phase: 'detail' as const, label: 'Strategy details' }
      : phase === 'review'
        ? { phase: 'limits' as const, label: 'Private limits' }
        : null;

  const currentStep = ['choose', 'detail', 'activate'].includes(phase) ? 0 : phase === 'limits' ? 1 : ['review', 'submitting'].includes(phase) ? 2 : 3;
  const title = phase === 'choose' ? 'Choose a strategy for your liquidity.'
    : phase === 'detail' ? selected[0]?.name ?? 'Strategy details.'
      : phase === 'activate' ? 'Add liquidity from your wallet.'
      : phase === 'limits' ? 'Set your liquidity limits.'
      : phase === 'review' ? 'Review your setup.'
        : phase === 'submitting' ? reevaluating ? 'Checking current conditions.' : 'Securing your setup.'
          : 'Your liquidity.';

  // A direct setup link renders its own loading or connection state, never a flash of the marketplace.
  if ((phase === 'choose' && (linkedMandateId || linkedId)) || loadingLinked) {
    const backHref = linkedMandateId ? '/profile?tab=making' : '/maker';
    const waitingForAccount = !account.ready || (!!linkedId && executableCatalog === null) || (!!linkedMandateId && refreshing);
    return <section className={aqua.flow}>
      <Link className={aqua.backLink} href={backHref}>← {linkedMandateId ? 'My liquidity' : 'All strategies'}</Link>
      <PageHead eyebrow={linkedMandateId ? 'My liquidity' : 'Liquidity setup'} title={linkedMandateId ? 'Your liquidity' : 'Set up your liquidity'} />
      {error ? <p role="alert" className={aqua.errorNotice}>{error}</p>
        : waitingForAccount ? <p role="status">Loading your workspace…</p>
          : !account.authenticated ? <Primary onClick={account.login}>Connect liquidity wallet</Primary>
            : linkedMandateId ? <p role="status">Loading your liquidity…</p>
              : !makerAddress ? <p>This setup belongs to a different liquidity wallet. Connect that wallet to continue.</p>
              : <p role="status">{linkedMandateId ? 'Loading your liquidity…' : 'Loading your strategy…'}</p>}
    </section>;
  }

  return <section className={aqua.flow}>
    {phase === 'monitor' && <Link href="/profile?tab=making" className={aqua.backLink}>← My liquidity</Link>}
    {previousStep && <button type="button" className={aqua.backLink} onClick={() => go(previousStep.phase)}>← {previousStep.label}</button>}
    <PageHead eyebrow="Liquidity" title={title} headingRef={heading} />
    <Steps steps={STEPS} current={currentStep} />
    {error && <div className={aqua.errorNotice} role="alert"><strong>Action required</strong><span>{error}</span></div>}

    {phase === 'choose' && <>
      <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Available strategies</h2><span className={aqua.muted}>{listings.length} strategies</span></div>
      <ListingGrid>
        {listings.map(item => <ListingCard key={item.id} listing={item} action={<StrategyLink id={item.id} ens={item.ensName} />} />)}
      </ListingGrid>
    </>}

    {phase === 'activate' && selected[0]?.releaseId && makerAddress && <MakerActivation key={`${makerAddress}:${selected[0].id}`} listing={selected[0]} maker={makerAddress} account={account}
      onReady={async () => {
        const catalog = await getExecutableStrategies(makerAddress);
        if (!catalog.strategies.some(item => item.id === selected[0].id)) throw new Error('Activation is confirmed, but the strategy catalog is not ready. Retry without signing again.');
        setExecutableCatalog({ maker: catalog.maker?.toLowerCase() ?? makerAddress, ids: new Set(catalog.strategies.map(item => item.id)) });
        go('limits');
      }} />}

    {phase === 'activate' && !makerAddress && <div className={aqua.panel}>
      {account.authenticated ? <p>This strategy belongs to a different liquidity wallet. Connect that wallet to continue.</p> : <Primary onClick={account.login}>Connect liquidity wallet</Primary>}
    </div>}

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private limits</legend>
          <p className={aqua.muted}>These limits apply to every trading mode used by this strategy.</p>
          <label>Capital available (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={event => setBudget(event.target.value)} /></label>
          <label>Maximum share held as WETH (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={event => setExposure(event.target.value)} /></label>
          <label>Maximum WETH inventory (USDC value)<FormInput inputMode="decimal" value={maxWethInventory} aria-invalid={!!positiveError(maxWethInventory) || toNumber(maxWethInventory) > toNumber(budget)} onChange={event => setMaxWethInventory(event.target.value)} /></label>
          <label>Maximum swap size (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={event => setMaxTrade(event.target.value)} /></label>
          <p className={aqua.hint}>These limits stay in effect until you change or revoke them. PinTool updates the onchain authorization only when the strategy conditions or your limits change.</p>
        </fieldset>
        <Primary type="submit" disabled={!valid}>Review limits</Primary>
      </form>
      <aside className={aqua.explanation}><h2>Limits enforced on every swap</h2><ul className={aqua.trustList}><li>Capital limits the total USDC this strategy may use.</li><li>Exposure and inventory limits cap the WETH your wallet may hold.</li><li>Maximum swap size applies to every trading mode.</li></ul><h3>Market</h3><p>WETH / USDC</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <StrategySet selected={selected} />
        {selected.filter(item => item.ensSelection).map(item => <p key={item.id} className={aqua.hint}>{item.ensSelection!.name} · version {item.version} is pinned. A later ENS update will not change this liquidity setup.</p>)}
        <PolicyMetrics budget={budget} exposure={exposure} maxWethInventory={maxWethInventory} maxTrade={maxTrade} />
        <div className={aqua.actionRow}><Primary onClick={submit}>Apply private limits</Primary><Secondary onClick={() => go('limits')}>Edit limits</Secondary></div>
      </div>
      <PrivacyRoute />
    </div>}

    {phase === 'submitting' && <RuntimePanel reevaluating={reevaluating} />}
    {phase === 'monitor' && mandate && <MandateMonitor mandate={mandate} refreshing={refreshing} reevaluating={reevaluating} onRefresh={refresh} onReevaluate={reevaluate} onEdit={editLimits} />}
    {phase === 'monitor' && mandate?.ensSelections?.map(selection => <p key={`${selection.name}:${selection.pointer.version}`} className={aqua.hint}>{selection.name} · pinned version {selection.pointer.version} · verified at Sepolia block {selection.verifiedBlock}</p>)}
  </section>;
}

function StrategySet({ selected }: { selected: Listing[] }) {
  return <div className={aqua.providerPair}>{selected.map(item => <div key={item.id}><ProviderIdentity listing={item} /><strong>{item.name}</strong><small>{item.template.label}</small></div>)}</div>;
}

function PolicyMetrics({ budget, exposure, maxWethInventory, maxTrade }: { budget: string; exposure: string; maxWethInventory: string; maxTrade: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>WETH exposure</span><strong>{exposure}% max</strong></div><div><span>WETH inventory</span><strong>{maxWethInventory} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Authorization</span><strong>Until changed or revoked</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>What becomes public</span><h2>Only the resulting authorization is published.</h2><div><span>Strategy rules</span><strong>Confidential</strong></div><div><span>Your liquidity limits</span><strong>Confidential</strong></div><div><span>Execution authorization</span><strong>Public and enforceable</strong></div></aside>;
}

function RuntimePanel({ reevaluating }: { reevaluating: boolean }) {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>Chainlink Confidential Workflow</span><h2>{reevaluating ? 'Checking current conditions' : 'Evaluating strategy and liquidity limits'}</h2><p>PinTool is applying both sets of private rules and confirming the resulting authorization onchain.</p></div><ol className={aqua.runtimeSteps}><li data-done>Strategy rules received</li><li data-done>Liquidity limits received</li><li data-active>Private rules being evaluated</li><li>Authorization confirmed</li></ol></div>;
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
      <div className={aqua.statusHeader}><span className={aqua.statusMark}>{active ? '✓' : '·'}</span><div><span className={aqua.eyebrow}>Current authorization</span><h2>{name}</h2></div></div>
      <div className={aqua.intentRows}><div><span>Current mode</span><strong>{now === 0 ? 'Checking…' : active ? profileName(active.listingId) : verified ? 'Paused' : 'Refresh to check'}</strong></div><div><span>Market</span><strong>WETH / USDC</strong></div><div><span>Network</span><strong>{mandate.evidence.networkName}</strong></div><div><span>Limits</span><strong>{mandate.evidence.expiresAt === null ? 'Active until changed' : 'Update required'}</strong></div></div>
      <div className={aqua.actionRow}><Primary disabled={reevaluating} onClick={() => onReevaluate()}>{reevaluating ? 'Checking…' : 'Check conditions now'}</Primary><Secondary disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</Secondary><Secondary disabled={reevaluating} onClick={onEdit}>Change limits</Secondary></div>
    </section>

    <section className={aqua.strategyRoster} aria-labelledby="strategy-roster-title">
      <div className={aqua.sectionTop}><h2 id="strategy-roster-title" className={aqua.sectionTitle}>Strategy modes</h2><span className={aqua.muted}>{adaptive ? 'One strategy · one wallet balance' : 'Self-custodial liquidity'}</span></div>
      {profiles.map(strategy => <article key={strategy.listingId} className={aqua.rosterRow} data-status={strategy.status}>
        <div><span className={aqua.eyebrow} title={strategy.provider}>{adaptive ? name : /^0x[a-f0-9]{40}$/i.test(strategy.provider ?? '') ? shortHash(strategy.provider!) : strategy.provider ?? 'Independent Provider'}</span><strong>{strategy.name}</strong></div>
        <div className={aqua.rosterStatus}>
          <span>{'readiness' in strategy && fresh(strategy) ? strategy.readiness?.authorized ? 'Active' : strategy.status === 'paused' ? 'Paused' : 'Standby' : 'Refresh to check'}</span>
          {'readiness' in strategy && <small>Authorization: {!fresh(strategy) ? 'check required' : strategy.readiness?.authorized ? 'active' : 'inactive'} · Aqua: {fresh(strategy) && strategy.readiness?.shipped ? 'ready' : 'check required'} · Funds: {fresh(strategy) && strategy.readiness?.funded ? 'ready' : 'check required'}</small>}
          {strategy.strategyHash && <CopyStrategyHash value={strategy.strategyHash} />}
        </div>
        <div className={aqua.rosterActions}>
          <Secondary disabled={reevaluating} onClick={() => onReevaluate(strategy.listingId)}>Check this mode</Secondary>
          <Link href={`/trade?strategy=${encodeURIComponent(strategy.listingId)}&mandate=${encodeURIComponent(mandate.mandateId)}`}>Open trade page ↗</Link>
        </div>
      </article>)}
    </section>

    <section className={aqua.activityPanel} aria-labelledby="mandate-activity-title">
      <div className={aqua.sectionTop}><h2 id="mandate-activity-title" className={aqua.sectionTitle}>Recent activity</h2><span className={aqua.muted}>{mandate.events.length} events</span></div>
      {mandate.events.length ? <ol className={aqua.activityList}>{mandate.events.map(event => {
        const title = event.title.replace('Tight Market', 'Tight mode').replace('Defensive Market', 'Defensive mode').replace('Guard authorization confirmed', 'Authorization updated');
        const detail = event.detail.startsWith('CRE execution ') ? 'PinTool published the new execution authorization on Ethereum Sepolia.'
          : event.detail === 'The strategy may execute within the confirmed Guard limits.' ? 'This strategy mode passed its private checks and is available for trading.'
            : event.detail === 'Aqua executed within the current Guard authorization.' ? 'Aqua settled the swap within the active authorization.'
              : event.detail === 'The inactive strategy was rejected by the Guard onchain.' ? 'PinTool blocked the swap because this strategy mode was inactive.' : event.detail;
        return <li key={event.id}><div><strong>{title}</strong><span>{detail}</span></div><div><time dateTime={event.occurredAt}>{now === 0 ? '—' : new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{event.explorerUrl && <a href={event.explorerUrl} target="_blank" rel="noreferrer">Transaction ↗</a>}</div></li>;
      })}</ol> : <p className={aqua.muted}>Confirmed activity will appear here.</p>}
    </section>

    <div className={aqua.evidence}><div><span>Latest authorization</span><a className={aqua.evidenceValue} href={mandate.evidence.reportExplorerUrl} target="_blank" rel="noreferrer" aria-label={`View authorization transaction ${mandate.evidence.reportTransactionHash} on Etherscan`}><code>{shortHash(mandate.evidence.reportTransactionHash)}</code><b>View ↗</b></a></div><div><span>Aqua setup</span><strong>{profiles.length} {profiles.length === 1 ? 'strategy mode uses' : 'strategy modes share'} this wallet&apos;s liquidity</strong></div><div><span>Current mode</span><strong>{now === 0 ? 'Checking…' : active ? profileName(active.listingId) : verified ? 'Paused' : 'Refresh to check'}</strong></div></div>
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
