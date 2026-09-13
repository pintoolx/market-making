'use client';
import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { canonical, defaultTemplatePermissions, publicationMessage, publicationVersion, templateDigest, templatePermissionsSchema,
  type PolicyEnvelope, type PublicationIntent, type TemplatePermissions } from '@pintool/strategy-builder';
import { encodePrivatePolicy, PrivatePolicyError, type PrivatePolicyForm } from '@pintool/strategy-builder/private-policy';
import { sealProviderStrategy } from '../marketplace/confidentialEnvelope';
import { BuilderError, type BuilderClient, type Draft, type PublishedTemplate, type TemplateItem } from './client';
import { verifyPublicationIntent, verifyPublishedTemplate } from './publication';
import PrivatePolicyFields from './PrivatePolicyFields';
import BuilderDialog from './BuilderDialog';
import StrategyDetails from './StrategyDetails';
import styles from './builder.module.css';

type Review = { intent: PublicationIntent; envelope: PolicyEnvelope; message: string };
export default function TemplatePublisher({ api, draft, signMessage, onClose, onSessionExpired }: {
  api: BuilderClient; draft: Draft; signMessage(message: string): Promise<`0x${string}`>; onClose(): void; onSessionExpired(): void;
}) {
  const base = draft.spec.baseToken!, quote = draft.spec.quoteToken!, caps = draft.spec.guardEnvelope!;
  const [form, setForm] = useState<PrivatePolicyForm | null>(() => ({ rules: [{ id: 'r-' + crypto.randomUUID(), priceMin: '', priceMax: '',
    volatilityBpsMin: '', volatilityBpsMax: '', allowMakerBuyBase: false, allowMakerSellBase: false,
    maxAmountBase: formatUnits(BigInt(caps.maxAmountBasePerSwap!), base.decimals), maxAmountQuote: formatUnits(BigInt(caps.maxAmountQuotePerSwap!), quote.decimals) }],
    maxBalanceBase: formatUnits(BigInt(caps.maxPostBalanceBase!), base.decimals), maxBalanceQuote: formatUnits(BigInt(caps.maxPostBalanceQuote!), quote.decimals) }));
  const [permissions, setPermissions] = useState<TemplatePermissions>({ ...defaultTemplatePermissions });
  const [series, setSeries] = useState<TemplateItem[]>([]), [templateId, setTemplateId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null), [published, setPublished] = useState<PublishedTemplate | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [checked, setChecked] = useState(false);
  const live = useRef(true), pending = useRef<{ signature: `0x${string}`; key: string } | null>(null), prepare = useRef<{ input: string; key: string } | null>(null);
  useEffect(() => {
    live.current = true;
    void api.templates().then(result => {
      if (live.current) setSeries(result.templates.filter(t => t.provider === draft.owner.slice(7)).filter((t, i, list) => list.findIndex(v => v.templateId === t.templateId) === i));
    }).catch(e => {
      if (!live.current) return;
      if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
      setError(e instanceof BuilderError ? e.message : 'Could not load existing templates.');
    });
    return () => { live.current = false; pending.current = null; prepare.current = null; };
  }, [api, draft.owner, onSessionExpired]);
  const clearReview = () => { setReview(null); setChecked(false); pending.current = null; };
  const failure = (e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    const rule = e instanceof PrivatePolicyError ? e.field.match(/^rules\.(\d+)/) : null;
    setError(e instanceof PrivatePolicyError ? `${rule ? `Rule ${Number(rule[1]) + 1}: ` : ''}${e.message}` : e instanceof BuilderError ? e.message : 'The action did not finish. Check your wallet or review again.');
    if (e instanceof BuilderError && e.status === 409) { clearReview(); prepare.current = null; }
  };
  async function prepareReview() {
    if (!form || busy || !checked) return;
    setBusy('Preparing version review'); setError('');
    try {
      // Validate before any network call. The final version ID is supplied by the server intent.
      encodePrivatePolicy(form, draft.spec, 'local-policy-validation');
      const checkedPermissions = templatePermissionsSchema.safeParse(permissions);
      if (!checkedPermissions.success) throw new PrivatePolicyError('permissions', 'Check the editable public bounds and number formats.');
      const p = checkedPermissions.data, input = canonical({ draftId: draft.id, revision: draft.revision, permissions: p, templateId });
      if (prepare.current?.input !== input) prepare.current = { input, key: crypto.randomUUID() };
      const result = await api.preparePublication(draft, templateId, p, prepare.current.key);
      if (!live.current) return;
      if (Date.parse(result.intent.expiresAt) <= Date.now()) { prepare.current = null; throw new BuilderError(409, 'publication-intent-expired'); }
      const intent = verifyPublicationIntent(result.intent, draft, p, templateId, window.location.origin);
      const policy = encodePrivatePolicy(form, draft.spec, intent.encryption.strategyId);
      const envelope = sealProviderStrategy(policy, intent.encryption.publicKey, intent.base.provider);
      setReview({ intent, envelope, message: publicationMessage(intent, envelope) }); pending.current = null;
    } catch (e) { failure(e); }
    finally { if (live.current) setBusy(''); }
  }
  async function publish() {
    if (!review || busy) return;
    setBusy(pending.current ? 'Confirming publication' : 'Sign the version in your wallet'); setError('');
    try {
      if (!pending.current) {
        if (Date.parse(review.intent.expiresAt) <= Date.now()) { clearReview(); prepare.current = null; throw new BuilderError(409, 'publication-intent-expired'); }
        const signature = await signMessage(review.message);
        if (!live.current) return;
        pending.current = { signature, key: crypto.randomUUID() };
      }
      const saved = await api.publish(review.intent.id, review.envelope, pending.current.signature, pending.current.key);
      if (!live.current) return;
      const expected = publicationVersion(review.intent, review.envelope);
      const verified = await verifyPublishedTemplate(saved, expected.templateId, expected.version, templateDigest(expected));
      if (!live.current) return;
      setPublished(verified); setForm(null); setReview(null); pending.current = null; prepare.current = null;
    } catch (e) { failure(e); }
    finally { if (live.current) setBusy(''); }
  }
  return <BuilderDialog title="Publish Provider template" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {published ? <div className={styles.publicationComplete}><span className={styles.eyebrow}>VERSION PUBLISHED</span><h3>{published.template.spec.title} · Version {published.template.version}</h3>
      <p>Template saved. Makers can select this version to create their own drafts. The private form has been cleared.</p><p>The encrypted policy still requires trusted workflow verification. Publication does not register liquidity or authorize swaps.</p><button className={styles.primary} onClick={onClose}>Back to strategy</button></div> : <>
      <section className={styles.publicReview}><span className={styles.eyebrow}>PUBLIC VERSION</span><h3>{draft.spec.title}</h3><p>{base.symbol} / {quote.symbol} · Draft v{draft.revision} · Zero fee</p>
        <StrategyDetails spec={draft.spec} requirements={draft.requirements} />
        <p>The version includes its public curve, Guard limits and requirements. Makers still need to compile, simulate and review their own allocations.</p>
        <fieldset disabled={!!busy || !!review}><label>Publish to template<select value={templateId ?? ''} onChange={e => { setTemplateId(e.target.value || null); clearReview(); }}>
          <option value="">Create a new template</option>{series.map(t => <option key={t.templateId} value={t.templateId}>{t.title} · Current version {t.version}</option>)}</select></label>
          <h4>Public parameters Makers may adjust</h4><div className={styles.checks}>
            <label><input type="checkbox" checked={permissions.tightenCaps} onChange={e => { setPermissions(p => ({ ...p, tightenCaps: e.target.checked })); clearReview(); }} />May tighten the four Guard limits</label>
            <label><input type="checkbox" checked={permissions.shortenDeadline} onChange={e => { setPermissions(p => ({ ...p, shortenDeadline: e.target.checked })); clearReview(); }} />May shorten the strategy deadline</label>
            {draft.spec.model?.kind === 'concentrated' && <label><input type="checkbox" checked={permissions.narrowConcentratedRange} onChange={e => { setPermissions(p => ({ ...p, narrowConcentratedRange: e.target.checked })); clearReview(); }} />May narrow the fixed price range</label>}
          </div>
          {draft.spec.model?.kind === 'pegged' && (['peggedReferencePrice', 'peggedAmplification'] as const).map(name => <div key={name}>
            <label className={styles.checkbox}><input type="checkbox" checked={!!permissions[name]} onChange={e => {
              const value = draft.spec.model?.kind === 'pegged' ? (name === 'peggedReferencePrice' ? draft.spec.model.referencePrice : draft.spec.model.amplification)! : '1';
              setPermissions(p => ({ ...p, [name]: e.target.checked ? { min: value, max: value } : null })); clearReview();
            }} />Allow changes to {name === 'peggedReferencePrice' ? 'Reference price' : 'Amplification'}</label>
            {permissions[name] && <div className={styles.formGrid}>{(['min', 'max'] as const).map(bound => <label key={bound}>{name === 'peggedReferencePrice' ? 'Reference price' : 'Amplification'}{bound === 'min' ? ' minimum' : ' maximum'}<input inputMode="decimal" value={permissions[name]![bound]} onChange={e => { setPermissions(p => ({ ...p, [name]: { ...p[name]!, [bound]: e.target.value } })); clearReview(); }} /></label>)}</div>}
          </div>)}
          <p className={styles.helper}>Personal titles and allocations are editable. The pair, curve, fee and other program settings are fixed. Editable limits remain bounded by this published version.</p>
        </fieldset>
      </section>
      {form && <fieldset className={styles.privateFieldset} disabled={!!busy || !!review}><PrivatePolicyFields value={form} draft={draft} onChange={value => { setForm(value); clearReview(); }} /></fieldset>}
      {!review ? <div className={styles.dialogFooter}><label className={styles.checkbox}><input type="checkbox" checked={checked} disabled={!!busy} onChange={e => setChecked(e.target.checked)} />I have reviewed the public parameters, editable bounds and private rules above</label>
        <button className={styles.primary} disabled={!checked || !!busy} onClick={() => void prepareReview()}>{busy || 'Encrypt and review version'}</button></div> : <div className={styles.dialogFooter}>
        <p>Publishing version {review.intent.base.version}. Private rules are encrypted. Sign the complete public version in your wallet; this signature does not authorize asset transfers.</p>
        <details><summary>View wallet signing message</summary><pre>{review.message}</pre></details>
        <div className={styles.actions}><button disabled={!!busy || !!pending.current} onClick={() => { clearReview(); prepare.current = null; }}>Back to editing</button>
          <button className={styles.primary} disabled={!!busy} onClick={() => void publish()}>{busy || (pending.current ? 'Retry publication confirmation' : 'Sign and publish')}</button></div>
      </div>}
    </>}
  </BuilderDialog>;
}
