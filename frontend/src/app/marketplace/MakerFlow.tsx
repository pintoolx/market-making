'use client';

import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { readProposals, useProposals } from './proposalStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const STEPS = ['Choose strategy', 'Set private limits', 'Evaluate', 'Execute'];
const FEATURED: Listing[] = AQUA_TEMPLATES.slice(0, 3).map(template => ({ id: `featured-${template.id}`, name: template.name, summary: template.summary, template, mine: false }));
type Phase = 'limits' | 'review' | 'evaluating' | 'approved' | 'rejected' | 'executing' | 'active';
type SwapState = 'idle' | 'settling' | 'settled' | 'checking' | 'blocked';

const toNumber = (value: string) => Number(value.replace(/,/g, '').trim());
const positiveError = (value: string) => !value.trim() ? '' : !(toNumber(value) > 0) ? 'Enter an amount above 0.' : '';
const percentageError = (value: string) => { const n = toNumber(value); return !value.trim() ? '' : !(n > 0 && n <= 100) ? 'Enter a percentage between 1 and 100.' : ''; };

export default function MakerFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const { published } = usePublishedListings();
  const { proposals, save } = useProposals();
  const [selected, setSelected] = useState<Listing | null>(null);
  const [budget, setBudget] = useState('1000');
  const [exposure, setExposure] = useState('60');
  const [maxWeakAsset, setMaxWeakAsset] = useState('350');
  const [maxTrade, setMaxTrade] = useState('100');
  const [validityMinutes, setValidityMinutes] = useState('15');
  const [phase, setPhase] = useState<Phase>('limits');
  const [swapState, setSwapState] = useState<SwapState>('idle');
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [selected, phase]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('strategy');
    if (!id) return;
    const listing = [...readPublished(), ...FEATURED].find(item => item.id === id);
    const saved = readProposals().find(item => item.id === id);
    if (listing) {
      setSelected(listing);
      setBudget(saved?.budget ?? '1000');
      setExposure(saved?.maxExposure ?? '60');
      setMaxWeakAsset(saved?.maxWeakAsset ?? '350');
      setMaxTrade(saved?.maxTrade ?? '100');
      setValidityMinutes(saved?.validityMinutes ?? '15');
      setPhase(saved ? 'review' : 'limits');
    }
    window.history.replaceState(null, '', '/maker');
  }, []);

  const listings = [...published, ...FEATURED.filter(sample => !published.some(item => item.template.id === sample.template.id))];
  const go = (fn: () => void) => { didNavigate.current = true; scrollTop(); fn(); };
  const choose = (listing: Listing) => go(() => {
    const saved = proposals.find(item => item.id === listing.id);
    setBudget(saved?.budget ?? '1000');
    setExposure(saved?.maxExposure ?? '60');
    setMaxWeakAsset(saved?.maxWeakAsset ?? '350');
    setMaxTrade(saved?.maxTrade ?? '100');
    setValidityMinutes(saved?.validityMinutes ?? '15');
    setSelected(listing);
    setPhase('limits');
    setSwapState('idle');
  });

  const valid = [budget, maxWeakAsset, maxTrade, validityMinutes].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
    && toNumber(maxWeakAsset) <= toNumber(budget)
    && toNumber(maxTrade) <= toNumber(budget);
  const compatible = toNumber(exposure) <= 70 && toNumber(maxWeakAsset) <= toNumber(budget) * .5;

  const savePolicy = () => {
    if (!selected || !valid) return;
    save({ id: selected.id, strategyName: selected.name, mechanism: selected.template.label, budget: budget.trim(), maxExposure: exposure.trim(), maxWeakAsset: maxWeakAsset.trim(), maxTrade: maxTrade.trim(), validityMinutes: validityMinutes.trim(), feePct: selected.feePct });
    go(() => setPhase('review'));
  };
  const evaluate = () => {
    go(() => setPhase('evaluating'));
    window.setTimeout(() => go(() => setPhase(compatible ? 'approved' : 'rejected')), 1050);
  };
  const activate = () => {
    go(() => setPhase('executing'));
    window.setTimeout(() => go(() => setPhase('active')), 1100);
  };
  const runSwap = (protectedDirection: boolean) => {
    setSwapState(protectedDirection ? 'checking' : 'settling');
    window.setTimeout(() => setSwapState(protectedDirection ? 'blocked' : 'settled'), 800);
  };

  if (!selected) return <section className={aqua.flow}>
    <PageHead eyebrow="Maker Marketplace" title="Choose a strategy." accent="Keep your limits private." headingRef={heading}>
      Each listing explains the public mandate. Your capital and inventory policy stay between you and the confidential workflow.
    </PageHead>
    <Steps steps={STEPS} current={0} />
    <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Available strategies</h2><span className={aqua.muted}>{listings.length} strategies</span></div>
    <div className={`${styles.grid} ${aqua.grid}`}>
      {listings.map(item => {
        const saved = proposals.some(p => p.id === item.id);
        return <ListingCard key={item.id} listing={item} action={<Primary onClick={() => choose(item)}>{saved ? 'Review policy' : 'Use strategy'}</Primary>} />;
      })}
    </div>
  </section>;

  const currentStep = phase === 'limits' ? 1 : ['review', 'evaluating', 'approved', 'rejected'].includes(phase) ? 2 : 3;
  const title = phase === 'limits' ? selected.name : phase === 'review' ? 'Review your private policy.' : phase === 'evaluating' ? 'Evaluating compatibility.' : phase === 'approved' ? 'Strategy approved.' : phase === 'rejected' ? 'Policy conflict.' : phase === 'executing' ? 'Activating on Aqua.' : 'Strategy active.';

  return <section className={aqua.flow}>
    <button type="button" className={aqua.backLink} onClick={() => go(() => setSelected(null))}>← All strategies</button>
    <PageHead eyebrow={`${selected.template.label} strategy`} title={title} accent={phase === 'approved' ? 'Your limits are preserved.' : phase === 'active' ? 'Guarded on every swap.' : undefined} headingRef={heading}>
      {phase === 'limits' && selected.summary}
      {phase === 'review' && 'Confirm what the confidential workflow may use before sending your encrypted policy.'}
      {phase === 'evaluating' && 'Chainlink combines the Provider logic, your policy and the current market state inside the TEE.'}
      {phase === 'approved' && 'The workflow produced a restricted execution intent without revealing either side’s private inputs.'}
      {phase === 'rejected' && 'The Provider strategy cannot operate inside your current limits.'}
      {phase === 'executing' && 'Your wallet authorizes the approved strategy and virtual balances.'}
      {phase === 'active' && 'Aqua settles permitted flow from your wallet while PinTool Guard rejects policy violations.'}
    </PageHead>
    <Steps steps={STEPS} current={currentStep} />

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private limits</legend>
          <p className={aqua.muted}>Encrypted for the confidential workflow. The Provider never receives these values.</p>
          <label>Capital budget (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={e => setBudget(e.target.value)} /><span className={aqua.hint}>Maximum virtual balance assigned to this strategy.</span></label>
          <label>Maximum single-asset exposure (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={e => setExposure(e.target.value)} /><span className={aqua.hint}>Largest permitted share of the budget in either asset.</span></label>
          <label>Maximum USDT inventory (USDC value)<FormInput inputMode="decimal" value={maxWeakAsset} aria-invalid={!!positiveError(maxWeakAsset) || toNumber(maxWeakAsset) > toNumber(budget)} onChange={e => setMaxWeakAsset(e.target.value)} /><span className={aqua.hint}>Stops the strategy from accumulating more USDT beyond this value.</span></label>
          <label>Maximum amount per swap (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={e => setMaxTrade(e.target.value)} /></label>
          <label>Policy validity (minutes)<FormInput inputMode="numeric" value={validityMinutes} aria-invalid={!!positiveError(validityMinutes)} onChange={e => setValidityMinutes(e.target.value)} /><span className={aqua.hint}>Trading stops if the latest confidential report expires.</span></label>
        </fieldset>
        {account.authenticated && account.embedded && <p className={aqua.notice}>Your Privy wallet needs USDC and USDT before this strategy can be activated.</p>}
        <Primary type="submit" disabled={!valid}>Review private policy</Primary>
      </form>
      <aside className={aqua.explanation}><h2>Policy boundary</h2><ul className={aqua.trustList}><li>Funds remain in your wallet.</li><li>The workflow may tighten these limits, never expand them.</li><li>The Guard checks direction, amount and report freshness on every swap.</li></ul><h3>Strategy risk</h3><p>{selected.template.risk}</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}><PolicyMetrics budget={budget} exposure={exposure} maxWeakAsset={maxWeakAsset} maxTrade={maxTrade} validity={validityMinutes} /><div className={aqua.actionRow}><Primary onClick={evaluate}>Run confidential evaluation</Primary><Secondary onClick={() => go(() => setPhase('limits'))}>Edit limits</Secondary></div></div>
      <PrivacyRoute />
    </div>}

    {phase === 'evaluating' && <RuntimePanel eyebrow="Chainlink Confidential Workflow" title="Evaluating inside the TEE" copy="Decrypting both inputs, checking policy compatibility and preparing the smallest enforceable report." steps={['Provider commitment verified', 'Maker policy decrypted', 'Constraints being evaluated', 'Execution intent sealed']} />}

    {phase === 'approved' && <div className={aqua.decisionGrid}>
      <div className={`${aqua.panel} ${aqua.approvedPanel}`}><StatusHead label="Approved with limits" title="Restricted execution intent" mark="✓" /><div className={aqua.intentRows}><div><span>Maker receives USDT</span><strong>Allowed</strong></div><div><span>Maker pays USDT</span><strong>Allowed</strong></div><div><span>Maximum swap</span><strong>{maxTrade} USDC</strong></div><div><span>Report validity</span><strong>{validityMinutes} minutes</strong></div></div><p className={aqua.muted}>Raw Provider logic and your original policy are absent from this intent.</p><div className={aqua.actionRow}><Primary onClick={activate}>Review and activate</Primary><Secondary onClick={() => go(() => setPhase('limits'))}>Change policy</Secondary></div></div>
      <PrivacyRoute />
    </div>}

    {phase === 'rejected' && <div className={aqua.decisionGrid}>
      <div className={`${aqua.panel} ${aqua.rejectedPanel}`}><StatusHead label="Rejected safely" title="No executable intent was produced" mark="×" /><p>The strategy requires more inventory freedom than your policy permits. No Aqua authorization or execution payload was created.</p><div className={aqua.actionRow}><Primary onClick={() => go(() => setPhase('limits'))}>Adjust policy</Primary><Secondary onClick={() => go(() => setSelected(null))}>Choose another strategy</Secondary></div></div>
      <PrivacyRoute />
    </div>}

    {phase === 'executing' && <RuntimePanel eyebrow="1inch Aqua / SwapVM" title="Activating maker strategy" copy="Signing the approved program, assigning virtual balances and connecting PinTool Guard." steps={['Execution intent verified', 'SwapVM program compiled', 'Wallet authorization pending', 'Aqua strategy active']} />}

    {phase === 'active' && <div className={aqua.executionLayout}>
      <div className={aqua.panel}><StatusHead label="Aqua strategy active" title="USDC / USDT liquidity" mark="✓" /><div className={aqua.intentRows}><div><span>Pricing</span><strong>PeggedSwap + Fee</strong></div><div><span>Settlement</span><strong>Maker wallet</strong></div><div><span>Policy enforcement</span><strong>PinTool Guard</strong></div><div><span>Report freshness</span><strong>{validityMinutes} minutes</strong></div></div></div>
      <div className={aqua.swapTests}><article><span className={aqua.eyebrow}>Permitted flow</span><h3>Maker pays USDT</h3><p>The Taker pays USDC and receives USDT, reducing the Maker&apos;s USDT inventory.</p><Primary disabled={swapState === 'settling' || swapState === 'checking'} onClick={() => runSwap(false)}>{swapState === 'settling' ? 'Settling…' : swapState === 'settled' ? 'Settled through Aqua' : 'Execute swap'}</Primary></article><article><span className={aqua.eyebrow}>Protected flow</span><h3>Maker receives USDT</h3><p>The Taker pays USDT and receives USDC. Guard checks the Maker&apos;s resulting USDT inventory before settlement.</p><Secondary disabled={swapState === 'settling' || swapState === 'checking'} onClick={() => runSwap(true)}>{swapState === 'checking' ? 'Checking policy…' : swapState === 'blocked' ? 'Blocked by PinTool Guard' : 'Execute swap'}</Secondary></article></div>
      <div className={aqua.evidence}><div><span>Confidential report</span><strong>Verified by Guard</strong></div><div><span>Aqua strategy</span><strong>Active</strong></div><div><span>Wallet custody</span><strong>Maker retained</strong></div></div>
    </div>}
  </section>;
}

function PolicyMetrics({ budget, exposure, maxWeakAsset, maxTrade, validity }: { budget: string; exposure: string; maxWeakAsset: string; maxTrade: string; validity: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>Single-asset exposure</span><strong>{exposure}% max</strong></div><div><span>USDT inventory</span><strong>{maxWeakAsset} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Policy validity</span><strong>{validity} minutes</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>Disclosure boundary</span><h2>Only the result leaves the TEE.</h2><div><span>Provider logic</span><strong>Encrypted</strong></div><div><span>Maker policy</span><strong>Encrypted</strong></div><div><span>Execution intent</span><strong>Minimal public output</strong></div></aside>;
}

function StatusHead({ label, title, mark }: { label: string; title: string; mark: string }) {
  return <div className={aqua.statusHeader}><span className={aqua.statusMark}>{mark}</span><div><span className={aqua.eyebrow}>{label}</span><h2>{title}</h2></div></div>;
}

function RuntimePanel({ eyebrow, title, copy, steps }: { eyebrow: string; title: string; copy: string; steps: string[] }) {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>{eyebrow}</span><h2>{title}</h2><p>{copy}</p></div><ol className={aqua.runtimeSteps}>{steps.map((step, index) => <li key={step} data-done={index < 2 || undefined} data-active={index === 2 || undefined}>{step}</li>)}</ol></div>;
}
