'use client';

import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import {
  evaluateMandate,
  executeStrategySwap,
  transitionMandate,
  type MandateEvaluation,
  type StrategySlot,
  type SwapEvidence,
} from './mandateClient';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { useProposals } from './proposalStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const STEPS = ['Choose providers', 'Set private limits', 'Evaluate', 'Execute'];
const FEATURED: Listing[] = [
  {
    id: 'featured-tight-market',
    name: 'Tight Market',
    summary: 'A tight-spread WETH / USDC strategy designed for normal market conditions.',
    template: AQUA_TEMPLATES[0],
    mine: false,
    provider: 'Provider A',
  },
  {
    id: 'featured-defensive-market',
    name: 'Defensive Market',
    summary: 'A wider-spread WETH / USDC strategy that reduces exposure when volatility rises.',
    template: AQUA_TEMPLATES[4],
    mine: false,
    provider: 'Provider B',
  },
];

type Phase = 'choose' | 'limits' | 'review' | 'evaluating' | 'active';
type SwapState = { slot: StrategySlot; pending: boolean; evidence?: SwapEvidence };

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
  const [evaluation, setEvaluation] = useState<MandateEvaluation | null>(null);
  const [swap, setSwap] = useState<SwapState | null>(null);
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
      : current.length < 2 ? [...current, listing] : current);
  };

  const valid = [budget, maxWethInventory, maxTrade, validityMinutes].every(value => value.trim() && !positiveError(value))
    && !!exposure.trim() && !percentageError(exposure)
    && toNumber(maxWethInventory) <= toNumber(budget)
    && toNumber(maxTrade) <= toNumber(budget);

  const savePolicy = () => {
    if (!valid || selected.length !== 2) return;
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

  const evaluate = async () => {
    if (!account.address || selected.length !== 2) {
      setError('Log in with the Maker wallet before submitting the private mandate.');
      return;
    }
    go('evaluating');
    try {
      const result = await evaluateMandate({
        maker: account.address,
        providerStrategies: selected.map((item, index) => ({
          slot: index === 0 ? 'A' : 'B',
          listingId: item.id,
        })),
        policy: {
          capitalBudgetUsdc: budget.trim(),
          maxWethExposurePct: exposure.trim(),
          maxWethInventoryUsdc: maxWethInventory.trim(),
          maxSwapUsdc: maxTrade.trim(),
          validityMinutes: validityMinutes.trim(),
        },
      });
      setEvaluation(result);
      setSwap(null);
      go('active');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The confidential evaluation could not be completed.');
      setPhase('review');
    }
  };

  const transition = async () => {
    if (!evaluation) return;
    setError('');
    try {
      const result = await transitionMandate(evaluation.mandateId);
      setEvaluation(result);
      setSwap(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The mandate transition could not be completed.');
    }
  };

  const runSwap = async (slot: StrategySlot) => {
    if (!evaluation) return;
    setError('');
    setSwap({ slot, pending: true });
    try {
      const evidence = await executeStrategySwap(evaluation.mandateId, slot);
      setSwap({ slot, pending: false, evidence });
    } catch (reason) {
      setSwap(null);
      setError(reason instanceof Error ? reason.message : 'The swap request failed before a receipt was returned.');
    }
  };

  const currentStep = phase === 'choose' ? 0 : phase === 'limits' ? 1 : ['review', 'evaluating'].includes(phase) ? 2 : 3;
  const title = phase === 'choose' ? 'Choose two private strategies.'
    : phase === 'limits' ? 'Set one mandate for both.'
      : phase === 'review' ? 'Review your private mandate.'
        : phase === 'evaluating' ? 'Finding the permitted strategy.'
          : 'One balance. One active mandate.';

  return <section className={aqua.flow}>
    {phase !== 'choose' && <button type="button" className={aqua.backLink} onClick={() => go('choose')}>← Provider strategies</button>}
    <PageHead eyebrow="Maker Marketplace" title={title} accent={phase === 'active' ? 'Guarded on every swap.' : undefined} headingRef={heading}>
      {phase === 'choose' && 'Pair two Providers against the same private capital policy. The workflow authorizes only the strategy that fits the current market and your limits.'}
      {phase === 'limits' && 'Your WETH exposure and capital limits remain hidden from both Providers.'}
      {phase === 'review' && 'Only a short-lived strategy mandate will leave the confidential workflow.'}
      {phase === 'evaluating' && 'Chainlink combines both Provider policies, your mandate and the current market state inside the TEE.'}
      {phase === 'active' && 'Both Aqua strategies use the same Maker wallet. PinTool Guard permits only the strategy named by the latest report.'}
    </PageHead>
    <Steps steps={STEPS} current={currentStep} />
    {error && <div className={aqua.errorNotice} role="alert"><strong>Action required</strong><span>{error}</span></div>}

    {phase === 'choose' && <>
      <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>Provider strategies</h2><span className={aqua.muted}>{selected.length} of 2 selected</span></div>
      <div className={`${styles.grid} ${aqua.grid}`}>
        {listings.map(item => {
          const index = selected.findIndex(entry => entry.id === item.id);
          return <ListingCard key={item.id} listing={item} action={<Secondary aria-pressed={index >= 0} disabled={index < 0 && selected.length === 2} onClick={() => toggle(item)}>{index >= 0 ? `Selected as Strategy ${index === 0 ? 'A' : 'B'}` : 'Add to mandate'}</Secondary>} />;
        })}
      </div>
      <div className={aqua.selectionBar}>
        <div><span className={aqua.eyebrow}>Shared-liquidity mandate</span><strong>{selected.length === 2 ? `${selected[0].name} + ${selected[1].name}` : 'Select two Provider strategies'}</strong></div>
        <Primary disabled={selected.length !== 2} onClick={() => go('limits')}>Set private limits</Primary>
      </div>
    </>}

    {phase === 'limits' && <div className={aqua.editorGrid}>
      <form className={aqua.panel} noValidate onSubmit={event => { event.preventDefault(); savePolicy(); }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private mandate</legend>
          <p className={aqua.muted}>Encrypted for the confidential workflow. Neither Provider receives these values.</p>
          <label>Capital budget (USDC)<FormInput inputMode="decimal" value={budget} aria-invalid={!!positiveError(budget)} onChange={event => setBudget(event.target.value)} /></label>
          <label>Maximum WETH exposure (%)<FormInput inputMode="decimal" value={exposure} aria-invalid={!!percentageError(exposure)} onChange={event => setExposure(event.target.value)} /></label>
          <label>Maximum WETH inventory (USDC value)<FormInput inputMode="decimal" value={maxWethInventory} aria-invalid={!!positiveError(maxWethInventory) || toNumber(maxWethInventory) > toNumber(budget)} onChange={event => setMaxWethInventory(event.target.value)} /></label>
          <label>Maximum amount per swap (USDC)<FormInput inputMode="decimal" value={maxTrade} aria-invalid={!!positiveError(maxTrade) || toNumber(maxTrade) > toNumber(budget)} onChange={event => setMaxTrade(event.target.value)} /></label>
          <label>Mandate validity (minutes)<FormInput inputMode="numeric" value={validityMinutes} aria-invalid={!!positiveError(validityMinutes)} onChange={event => setValidityMinutes(event.target.value)} /><span className={aqua.hint}>Trading stops when the latest report expires.</span></label>
        </fieldset>
        <Primary type="submit" disabled={!valid}>Review private mandate</Primary>
      </form>
      <aside className={aqua.explanation}><h2>Two Providers, one boundary</h2><ul className={aqua.trustList}><li>Both strategies draw from the same Maker wallet.</li><li>The workflow may tighten your limits, never expand them.</li><li>The Guard authorizes one strategy hash at a time.</li></ul><h3>Execution pair</h3><p>WETH / USDC on Ethereum Sepolia. Aqua virtual balances avoid moving capital when the active strategy changes.</p></aside>
    </div>}

    {phase === 'review' && <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <ProviderPair selected={selected} />
        <PolicyMetrics budget={budget} exposure={exposure} maxWethInventory={maxWethInventory} maxTrade={maxTrade} validity={validityMinutes} />
        <div className={aqua.actionRow}><Primary onClick={evaluate}>Run confidential evaluation</Primary><Secondary onClick={() => go('limits')}>Edit limits</Secondary></div>
      </div>
      <PrivacyRoute />
    </div>}

    {phase === 'evaluating' && <RuntimePanel />}
    {phase === 'active' && evaluation && <ExecutionPanel evaluation={evaluation} selected={selected} swap={swap} onSwap={runSwap} onTransition={transition} />}
  </section>;
}

function ProviderPair({ selected }: { selected: Listing[] }) {
  return <div className={aqua.providerPair}>{selected.map((item, index) => <div key={item.id}><span>Strategy {index === 0 ? 'A' : 'B'}</span><strong>{item.name}</strong><small>{item.provider ?? 'Independent Provider'}</small></div>)}</div>;
}

function PolicyMetrics({ budget, exposure, maxWethInventory, maxTrade, validity }: { budget: string; exposure: string; maxWethInventory: string; maxTrade: string; validity: string }) {
  return <div className={aqua.policyReview}><div><span>Capital budget</span><strong>{budget} USDC</strong></div><div><span>WETH exposure</span><strong>{exposure}% max</strong></div><div><span>WETH inventory</span><strong>{maxWethInventory} USDC max</strong></div><div><span>Per swap</span><strong>{maxTrade} USDC max</strong></div><div><span>Mandate validity</span><strong>{validity} minutes</strong></div></div>;
}

function PrivacyRoute() {
  return <aside className={aqua.privacyRoute}><span className={aqua.eyebrow}>Disclosure boundary</span><h2>Only the mandate leaves the TEE.</h2><div><span>Provider policies</span><strong>Encrypted</strong></div><div><span>Maker limits</span><strong>Encrypted</strong></div><div><span>Active strategy + caps</span><strong>Public and enforceable</strong></div></aside>;
}

function RuntimePanel() {
  return <div className={aqua.runtimePanel} role="status" aria-live="polite"><div className={aqua.runtimePulse} aria-hidden="true" /><div><span className={aqua.eyebrow}>Chainlink Confidential Workflow</span><h2>Evaluating inside the TEE</h2><p>Decrypting three private inputs, applying the Maker&apos;s hard limits and delivering a short-lived report to PinTool Guard.</p></div><ol className={aqua.runtimeSteps}><li data-done>Provider A commitment verified</li><li data-done>Provider B commitment verified</li><li data-active>Maker mandate being evaluated</li><li>Guard report delivery</li></ol></div>;
}

function ExecutionPanel({ evaluation, selected, swap, onSwap, onTransition }: { evaluation: MandateEvaluation; selected: Listing[]; swap: SwapState | null; onSwap: (slot: StrategySlot) => void; onTransition: () => void }) {
  const expires = new Date(evaluation.evidence.expiresAt);
  return <div className={aqua.executionLayout}>
    <div className={aqua.panel}>
      <div className={aqua.statusHeader}><span className={aqua.statusMark}>✓</span><div><span className={aqua.eyebrow}>Mandate sequence {evaluation.evidence.sequence}</span><h2>{evaluation.regime === 'normal' ? 'Normal market' : 'High-volatility market'}</h2></div></div>
      <div className={aqua.intentRows}><div><span>Active strategy</span><strong>Strategy {evaluation.activeSlot}</strong></div><div><span>Pair</span><strong>WETH / USDC</strong></div><div><span>Network</span><strong>{evaluation.evidence.networkName}</strong></div><div><span>Expires</span><strong>{Number.isNaN(expires.valueOf()) ? evaluation.evidence.expiresAt : expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></div></div>
      <a className={aqua.evidenceLink} href={evaluation.evidence.reportExplorerUrl} target="_blank" rel="noreferrer">Guard update {shortHash(evaluation.evidence.reportTransactionHash)} ↗</a>
      <Secondary onClick={onTransition}>Re-evaluate after market change</Secondary>
    </div>
    <div className={aqua.strategyExecutionList}>
      {evaluation.decisions.map(decision => {
        const listing = selected[decision.slot === 'A' ? 0 : 1];
        const current = swap?.slot === decision.slot ? swap : null;
        return <article key={decision.slot} className={aqua.strategyExecution} data-allowed={decision.allowed || undefined}>
          <div className={aqua.strategyExecutionHead}><span>Strategy {decision.slot}</span><strong>{listing?.name ?? decision.listingId}</strong><small>{decision.allowed ? 'Authorized by the latest mandate' : 'Blocked by the latest mandate'}</small></div>
          <div className={aqua.strategyHash}><span>Strategy hash</span><code>{shortHash(decision.strategyHash)}</code></div>
          {current?.evidence && <SwapReceipt evidence={current.evidence} />}
          <Primary disabled={current?.pending} onClick={() => onSwap(decision.slot)}>{current?.pending ? 'Waiting for receipt…' : decision.allowed ? 'Execute permitted swap' : 'Prove Guard rejection'}</Primary>
        </article>;
      })}
    </div>
    <div className={aqua.evidence}><div><span>Confidential report</span><strong>{shortHash(evaluation.evidence.reportDigest)}</strong></div><div><span>Aqua strategies</span><strong>Shared Maker balance</strong></div><div><span>Active strategy</span><strong>Strategy {evaluation.activeSlot} only</strong></div></div>
  </div>;
}

function SwapReceipt({ evidence }: { evidence: SwapEvidence }) {
  return <div className={aqua.swapReceipt} data-status={evidence.status}><strong>{evidence.status === 'settled' ? 'Swap settled' : 'Guard rejected swap'}</strong><span>{evidence.tokenIn} → {evidence.tokenOut}</span>{evidence.revertReason && <span>{evidence.revertReason}</span>}<a href={evidence.explorerUrl} target="_blank" rel="noreferrer">Transaction {shortHash(evidence.transactionHash)} ↗</a></div>;
}
