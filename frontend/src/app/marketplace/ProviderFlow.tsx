'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { useAccount, shortAddress } from '../providers/useAccount';
import { useBasicProfile } from '../profile/profileStore';
import { AQUA_TEMPLATES, CATEGORY_LABELS, type AquaTemplate } from './aquaTemplates';
import { readPublished, usePublishedListings, type Listing } from './publishedStore';
import { ListingCard, PageHead, Steps } from './ui';
import styles from './page.module.css';
import aqua from './aqua.module.css';

const CATEGORIES = ['All', ...Object.keys(CATEGORY_LABELS)] as const;
const STEPS = ['Choose a template', 'Write your logic', 'Publish'];
type Draft = { name: string; introduction: string; rules: string; fee: string };
const DEFAULT_FEE = '10';
const MAX_FEE = 30;
const feeError = (value: string) => { const n = Number(value.trim()); return value.trim() === '' || !Number.isFinite(n) || n < 0 || n > MAX_FEE ? `Enter a number from 0 to ${MAX_FEE}.` : ''; };

// Drafts survive switching pages within this browser tab, and are dropped once published.
const DRAFTS_KEY = 'pintool.aqua.drafts';
const readDrafts = (): Record<string, Draft> => { try { return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}'); } catch { return {}; } };
const writeDrafts = (drafts: Record<string, Draft>) => { try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* storage unavailable */ } };

export default function ProviderFlow({ scrollTop }: { scrollTop: () => void }) {
  const router = useRouter();
  const account = useAccount();
  const { profile } = useBasicProfile(account.userId ?? 'guest');
  const { published, publish } = usePublishedListings();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');
  const [selected, setSelected] = useState<AquaTemplate | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [preview, setPreview] = useState(false);
  const [done, setDone] = useState<Listing | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const didNavigate = useRef(false);

  useEffect(() => { if (didNavigate.current) heading.current?.focus(); }, [selected, preview, done]);

  // Load drafts, and handle /studio?edit=<templateId> (from the profile page) in the same pass: the published
  // listing is copied into the saved drafts first, so running this again (React dev double-run) gives the same result.
  useEffect(() => {
    const saved = readDrafts();
    const id = new URLSearchParams(window.location.search).get('edit');
    const template = id ? AQUA_TEMPLATES.find(t => t.id === id) : undefined;
    if (id && template) {
      const listing = readPublished().find(item => item.template.id === id);
      if (listing && !saved[id]) saved[id] = { name: listing.name, introduction: listing.summary, rules: '', fee: String(listing.feePct ?? DEFAULT_FEE) };
      writeDrafts(saved);
      setSelected(template);
      window.history.replaceState(null, '', '/studio');
    }
    setDrafts(saved);
  }, []);

  const providerName = profile.displayName || account.email || (account.address ? shortAddress(account.address) : undefined);
  const needsLogin = account.enabled && !account.authenticated;
  const visible = AQUA_TEMPLATES.filter(item =>
    (category === 'All' || item.category === category) &&
    `${item.name} ${item.label} ${item.mechanism} ${item.summary}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const stored = selected ? drafts[selected.id] : undefined;
  const draft = selected ? { name: selected.name, introduction: selected.summary, rules: '', fee: DEFAULT_FEE, ...stored } : null;
  const draftReady = !!draft && !!draft.name.trim() && !!draft.introduction.trim() && !!draft.rules.trim() && !feeError(draft.fee);
  const feePct = draft && !feeError(draft.fee) ? Number(draft.fee) : undefined;

  const go = (fn: () => void) => { didNavigate.current = true; scrollTop(); fn(); };
  // Always build on the latest drafts so quick successive edits don't overwrite each other.
  const updateDraft = (field: keyof Draft, value: string) => {
    if (!selected) return;
    const base = { name: selected.name, introduction: selected.summary, rules: '', fee: DEFAULT_FEE };
    setDrafts(current => {
      const next = { ...current, [selected.id]: { ...base, ...current[selected.id], [field]: value } };
      writeDrafts(next);
      return next;
    });
  };
  const publishNow = () => {
    if (!selected || !draft) return;
    publish(selected, draft.name.trim(), draft.introduction.trim(), providerName, feePct ?? 0, profile.avatar);
    const rest = { ...drafts };
    delete rest[selected.id];
    setDrafts(rest);
    writeDrafts(rest);
    go(() => setDone({ id: `mine-${selected.id}`, name: draft.name.trim(), summary: draft.introduction.trim(), template: selected, mine: true, provider: providerName, providerAvatar: profile.avatar || undefined, feePct }));
  };
  const startOver = () => go(() => { setDone(null); setSelected(null); setPreview(false); });
  // Opening a published strategy from the list starts from what was published, not the template defaults.
  const openTemplate = (item: AquaTemplate) => go(() => {
    const listing = published.find(p => p.template.id === item.id);
    if (listing && !drafts[item.id]) {
      const next = { ...drafts, [item.id]: { name: listing.name, introduction: listing.summary, rules: '', fee: String(listing.feePct ?? DEFAULT_FEE) } };
      setDrafts(next);
      writeDrafts(next);
    }
    setSelected(item);
    setPreview(false);
  });

  if (done) return <section className={aqua.flow}>
    <PageHead eyebrow="Published" title="Your strategy is live." accent={done.name} headingRef={heading}>
      Makers can now find it in the marketplace. Your private logic was not saved anywhere.
    </PageHead>
    <Steps steps={STEPS} current={STEPS.length} />
    <div className={aqua.editorGrid}>
      <div className={aqua.previewColumn}>
        <ListingCard listing={done} />
        <div className={aqua.actionRow}>
          <Primary onClick={() => router.push('/maker')}>See it in the marketplace</Primary>
          <Secondary onClick={startOver}>Create another</Secondary>
        </div>
        <button type="button" className={aqua.textLink} onClick={() => router.push('/profile?tab=providing')}>Manage your strategies in Profile →</button>
      </div>
    </div>
  </section>;

  if (selected && draft) return <section className={aqua.flow}>
    <button type="button" className={aqua.backLink} onClick={() => go(() => { setSelected(null); setPreview(false); })}>← All templates</button>
    <PageHead eyebrow={`${selected.label} template`} title={preview ? 'Check your listing.' : selected.name} accent={preview ? 'This is what Makers see.' : undefined} headingRef={heading}>
      {preview ? 'Your private logic is not shown here. Publish when the description reads right.' : selected.summary}
    </PageHead>
    <Steps steps={STEPS} current={preview ? 2 : 1} />
    <div className={aqua.editorGrid}>
      {preview ? <div className={aqua.previewColumn}>
        <ListingCard listing={{ id: 'preview', name: draft.name, summary: draft.introduction, template: selected, mine: true, provider: needsLogin ? undefined : providerName, providerAvatar: needsLogin ? undefined : profile.avatar || undefined, feePct }} />
        <div className={aqua.actionRow}>
          {needsLogin ? <Primary onClick={account.login}>Log in to publish</Primary> : <Primary onClick={publishNow}>Publish strategy</Primary>}
          <Secondary onClick={() => go(() => setPreview(false))}>Edit</Secondary>
        </div>
        {needsLogin && <p className={aqua.muted}>Your name goes on the listing so Makers know who provides it.</p>}
      </div> : <form className={aqua.panel} onSubmit={event => { event.preventDefault(); if (draftReady) go(() => setPreview(true)); }}>
        <fieldset>
          <legend>Public listing</legend>
          <label>Strategy name<FormInput required maxLength={80} value={draft.name} onChange={e => updateDraft('name', e.target.value)} /></label>
          <label>What does this strategy do?<textarea required maxLength={600} rows={3} value={draft.introduction} onChange={e => updateDraft('introduction', e.target.value)} /></label>
          <label>Your fee (% of Maker profit)
            <FormInput inputMode="decimal" value={draft.fee} aria-invalid={!!feeError(draft.fee)} onChange={e => updateDraft('fee', e.target.value)} />
            <span className={feeError(draft.fee) ? aqua.fieldError : aqua.hint}>{feeError(draft.fee) || 'Makers pay this only when your strategy makes them a profit. 0 means free.'}</span>
          </label>
        </fieldset>
        <fieldset className={aqua.privateField}>
          <legend>Private logic</legend>
          <p className={aqua.muted}>Makers never see this. It is not saved after you publish.</p>
          <label>Your logic<textarea required maxLength={4000} rows={6} placeholder={selected.prompt} value={draft.rules} onChange={e => updateDraft('rules', e.target.value)} /></label>
        </fieldset>
        <Primary type="submit" disabled={!draftReady}>Continue</Primary>
        {!draftReady && <p className={aqua.muted}>Fill in every field to continue.</p>}
      </form>}
      <aside className={aqua.explanation}>
        <h2>What happens next</h2>
        <ol>
          <li><strong>You publish</strong><p>Makers see the name, description and your fee. Your logic stays private: {selected.privateInputs.toLowerCase()}</p></li>
          <li><strong>Makers add their limits</strong><p>Each Maker sets their own budget and exposure. You never see them.</p></li>
          <li><strong>The TEE combines both</strong><p>Only a plan that fits both sides can run on 1inch Aqua.</p></li>
          <li><strong>You earn when they earn</strong><p>If a Maker profits, you receive your fee from that profit.</p></li>
        </ol>
        <h3>Know the trade-off</h3><p>{selected.risk}</p>
        <p className={aqua.muted}>Aqua mechanism: {selected.mechanism}</p>
      </aside>
    </div>
  </section>;

  return <section className={aqua.flow}>
    <PageHead eyebrow="Provider Studio" title="Start with a template." accent="Make it your own." headingRef={heading}>
      Pick the mechanism closest to your idea, then add the logic only you know.
    </PageHead>
    <Steps steps={STEPS} current={0} />
    <div className={aqua.search}>
      <FormInput fullWidth value={query} onChange={e => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates" />
      <div className={aqua.filters} aria-label="Template categories">
        {CATEGORIES.map(item => <Secondary key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'All' ? 'All' : CATEGORY_LABELS[item as keyof typeof CATEGORY_LABELS]}</Secondary>)}
      </div>
    </div>
    <div className={aqua.sectionTop}>
      <h2 className={aqua.sectionTitle}>Strategy templates</h2>
      <span className={aqua.muted} role="status">{visible.length} templates</span>
    </div>
    <div className={`${styles.grid} ${aqua.grid}`}>
      {visible.map(item => {
        const hasDraft = !!drafts[item.id];
        const isPublished = published.some(p => p.template.id === item.id);
        return <article key={item.id} className={`${styles.card} ${aqua.card}`}>
          <div className={styles.cardBg} aria-hidden="true" />
          <div className={styles.cardBody}>
            <div className={styles.tagRow}>
              <span className={`${styles.tag} ${aqua.chip}`}>{item.label}</span>
              {isPublished ? <span className={`${styles.tag} ${aqua.chip} ${aqua.mineTag}`}>Published</span> : hasDraft && <span className={`${styles.tag} ${aqua.chip} ${aqua.mineTag}`}>Draft</span>}
            </div>
            <h3 className={styles.cardTitle}>{item.name}</h3>
            <p className={aqua.summary}>{item.summary}</p>
            <div className={aqua.cardRule}><span className={aqua.eyebrow}>You define</span><p>{item.privateInputs}</p></div>
          </div>
          <div className={`${styles.cardActions} ${aqua.cardActions}`}>
            <Primary onClick={() => openTemplate(item)} aria-label={`Use the ${item.name} template`}>{hasDraft ? 'Continue draft' : isPublished ? 'Edit strategy' : 'Use template'}</Primary>
          </div>
        </article>;
      })}
    </div>
    {visible.length === 0 && <div className={aqua.empty}><h3>No matching templates</h3><p>Try a mechanism such as CLMM, or clear your filters.</p><Secondary onClick={() => { setQuery(''); setCategory('All'); }}>Clear filters</Secondary></div>}
  </section>;
}
