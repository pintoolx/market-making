'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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

const STEPS = ['Choose a strategy', 'Set your limits', 'Review proposal'];
const SAMPLES: Listing[] = AQUA_TEMPLATES.slice(0, 3).map(template => ({ id: `demo-${template.id}`, name: template.name, summary: template.summary, template, mine: false }));
const toNumber = (value: string) => Number(value.replace(/,/g, '').trim());
const budgetError = (value: string) => !value.trim() ? '' : !(toNumber(value) > 0) ? 'Enter an amount above 0.' : '';
const exposureError = (value: string) => { const n = toNumber(value); return !value.trim() ? '' : !(n > 0 && n <= 100) ? 'Enter a percentage between 1 and 100.' : ''; };

export default function MakerFlow({ scrollTop }: { scrollTop: () => void }) {
  const router = useRouter();
  const account = useAccount();
  const { published } = usePublishedListings();
  const { proposals, save } = useProposals();
  const [selected, setSelected] = useState<Listing | null>(null);
  const [budget, setBudget] = useState('');
  const [exposure, setExposure] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [selected, reviewing]);

  // /maker?strategy=<listing id> reopens a saved proposal (from the profile page). Read once, then drop the param.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('strategy');
    if (!id) return;
    const listing = [...readPublished(), ...SAMPLES].find(item => item.id === id);
    const saved = readProposals().find(item => item.id === id);
    if (listing) { setSelected(listing); setBudget(saved?.budget ?? ''); setExposure(saved?.maxExposure ?? ''); setReviewing(!!saved); }
    window.history.replaceState(null, '', '/maker');
  }, []);

  const listings = [...published, ...SAMPLES.filter(sample => !published.some(item => item.template.id === sample.template.id))];
  const go = (fn: () => void) => { didNavigate.current = true; scrollTop(); fn(); };
  const choose = (listing: Listing) => go(() => {
    // Picking a strategy again brings back the limits from its saved proposal.
    const saved = proposals.find(item => item.id === listing.id);
    setBudget(saved?.budget ?? '');
    setExposure(saved?.maxExposure ?? '');
    setSelected(listing);
    setReviewing(false);
  });
  const valid = !!budget.trim() && !!exposure.trim() && !budgetError(budget) && !exposureError(exposure);

  if (!selected) return <section className={aqua.flow}>
    <PageHead eyebrow="Maker Marketplace" title="Choose a strategy." accent="Keep your limits private." headingRef={heading}>
      Each listing shows what a strategy does. You set your own budget and exposure in the next step.
    </PageHead>
    <Steps steps={STEPS} current={0} />
    <div className={aqua.sectionTop}>
      <h2 className={aqua.sectionTitle}>Available strategies</h2>
      <span className={aqua.muted}>{listings.length} strategies</span>
    </div>
    <div className={`${styles.grid} ${aqua.grid}`}>
      {listings.map(item => {
        const saved = proposals.some(p => p.id === item.id);
        return <ListingCard key={item.id} listing={item} action={<Primary onClick={() => choose(item)} aria-label={`${saved ? 'Review' : 'Use'} ${item.name}`}>{saved ? 'Review your proposal' : 'Use strategy'}</Primary>} />;
      })}
    </div>
  </section>;

  const trust = <ul className={aqua.trustList}>
    <li>Your funds stay in your wallet. PinTool never holds them.</li>
    <li>The Provider never sees your limits, and you never see their logic.</li>
    <li>Nothing moves until you sign in your own wallet.</li>
    <li>{selected?.feePct ? `You pay the Provider's ${selected.feePct}% fee only when you make a profit.` : 'This strategy has no Provider fee.'}</li>
  </ul>;

  return <section className={aqua.flow}>
    <button type="button" className={aqua.backLink} onClick={() => go(() => setSelected(null))}>← All strategies</button>
    <PageHead eyebrow={`${selected.template.label} strategy`} title={reviewing ? 'Review your proposal.' : selected.name} accent={reviewing ? selected.name : undefined} headingRef={heading}>
      {reviewing ? 'Saved to your profile. Check the numbers before anything runs.' : selected.summary}
    </PageHead>
    <Steps steps={STEPS} current={reviewing ? 2 : 1} />
    <div className={aqua.editorGrid}>
      {!reviewing ? <form className={aqua.panel} noValidate onSubmit={event => {
        event.preventDefault();
        if (!valid) return;
        save({ id: selected.id, strategyName: selected.name, mechanism: selected.template.label, budget: budget.trim(), maxExposure: exposure.trim(), feePct: selected.feePct });
        go(() => setReviewing(true));
      }}>
        <fieldset className={aqua.privateField}>
          <legend>Your private limits</legend>
          <p className={aqua.muted}>Only the TEE reads these. The Provider never sees them.</p>
          <label>Budget (USDC)
            <FormInput inputMode="decimal" placeholder="e.g. 1,000" value={budget} aria-invalid={!!budgetError(budget)} onChange={e => setBudget(e.target.value)} />
            <span className={budgetError(budget) ? aqua.fieldError : aqua.hint}>{budgetError(budget) || 'The most this strategy may use from your wallet.'}</span>
          </label>
          <label>Max exposure (%)
            <FormInput inputMode="decimal" placeholder="e.g. 60" value={exposure} aria-invalid={!!exposureError(exposure)} onChange={e => setExposure(e.target.value)} />
            <span className={exposureError(exposure) ? aqua.fieldError : aqua.hint}>{exposureError(exposure) || 'The largest share of your budget that may end up in one token.'}</span>
          </label>
        </fieldset>
        {account.authenticated && account.embedded && <p className={aqua.notice}>You logged in with email, so your Privy wallet starts empty. Add funds before executing, or log in with your own wallet.</p>}
        <Primary type="submit" disabled={!valid}>Create proposal</Primary>
      </form> : <div className={aqua.panel}>
        <div className={`${styles.metrics} ${aqua.metrics}`}>
          <div><span className={styles.metricLabel}>Budget</span><span className={styles.metricValue}>{budget} USDC</span></div>
          <div><span className={styles.metricLabel}>Max exposure</span><span className={styles.metricValue}>{exposure}%</span></div>
          <div><span className={styles.metricLabel}>Provider fee</span><span className={styles.metricValue}>{selected.feePct ? `${selected.feePct}% of profit` : 'None'}</span></div>
        </div>
        <ol className={aqua.nextList}>
          <li>The TEE checks your limits against the Provider&apos;s logic.</li>
          <li>If they fit, you get an execution plan to review.</li>
          <li>You sign in your wallet to start. You can stop it at any time.</li>
        </ol>
        <div className={aqua.actionRow}>
          <Primary disabled>Execute with Aqua</Primary>
          <Secondary onClick={() => go(() => setReviewing(false))}>Edit limits</Secondary>
        </div>
        <p className={aqua.muted}>Execution on Aqua is not open yet. Your proposal is saved in <button type="button" className={aqua.inlineLink} onClick={() => router.push('/profile?tab=making')}>Profile → Making</button>.</p>
      </div>}
      <aside className={aqua.explanation}>
        <h2>Before you commit</h2>
        {trust}
        <h3>Strategy risk</h3><p>{selected.template.risk}</p>
        <p className={aqua.muted}>Limits reduce your exposure. They do not guarantee a maximum loss.</p>
      </aside>
    </div>
  </section>;
}
