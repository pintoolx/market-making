'use client';
import { useEffect, useRef, useState } from 'react';
import { allocationSchema, canonical, draftSchema, scaledDecimal, withdrawalMessage } from '@pintool/strategy-builder';
import { BuilderError, type BuilderClient, type Draft, type PublishedTemplate, type TemplateItem } from './client';
import { verifyPublishedTemplate } from './publication';
import BuilderDialog from './BuilderDialog';
import StrategyDetails from './StrategyDetails';
import styles from './builder.module.css';

export default function TemplateCatalog({ api, address, signMessage, onApply, onClose, onSessionExpired }: {
  api: BuilderClient; address: string; signMessage(message: string): Promise<`0x${string}`>;
  onApply(result: { conversationId: string; draft: Draft }): Promise<void>; onClose(): void; onSessionExpired(): void;
}) {
  const [items, setItems] = useState<TemplateItem[]>([]), [selected, setSelected] = useState<PublishedTemplate | null>(null);
  const [baseAmount, setBaseAmount] = useState(''), [quoteAmount, setQuoteAmount] = useState(''), [title, setTitle] = useState('');
  const [busy, setBusy] = useState('Loading templates'), [error, setError] = useState(''), [withdrawChecked, setWithdrawChecked] = useState(false);
  const live = useRef(true), epoch = useRef(0), applyPending = useRef<{ input: string; key: string } | null>(null);
  const withdrawPending = useRef<{ signature: `0x${string}`; key: string } | null>(null);
  useEffect(() => {
    live.current = true;
    void api.templates().then(result => { if (live.current) setItems(result.templates); }).catch(e => {
      if (!live.current) return;
      if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
      setError(e instanceof BuilderError ? e.message : 'Could not load templates.');
    })
      .finally(() => { if (live.current) setBusy(''); });
    return () => { live.current = false; };
  }, [api, onSessionExpired]);
  const fail = (e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    setError(e instanceof BuilderError ? e.message : 'The version or inputs could not be verified. Check the amounts and retry.');
  };
  async function choose(item: TemplateItem) {
    const ticket = ++epoch.current; setBusy('Verifying provider signature'); setError(''); setSelected(null);
    try {
      const saved = await verifyPublishedTemplate(await api.template(item.templateId, item.version), item.templateId, item.version, item.digest);
      if (!live.current || ticket !== epoch.current) return;
      setSelected(saved); setBaseAmount(''); setQuoteAmount(''); setTitle(saved.template.spec.title); setWithdrawChecked(false);
      applyPending.current = null; withdrawPending.current = null;
    } catch (e) { fail(e); }
    finally { if (live.current && ticket === epoch.current) setBusy(''); }
  }
  async function apply() {
    if (!selected || busy) return;
    const ticket = epoch.current; setBusy('Creating liquidity draft'); setError('');
    try {
      const base = selected.template.spec.baseToken!, quote = selected.template.spec.quoteToken!;
      const allocations = allocationSchema.parse({ baseAtomic: String(scaledDecimal(baseAmount, base.decimals)), quoteAtomic: String(scaledDecimal(quoteAmount, quote.decimals)) });
      if (!title.trim()) throw new Error('title required');
      const input = canonical({ id: selected.template.templateId, version: selected.template.version, digest: selected.digest, allocations, title: title.trim() });
      if (applyPending.current?.input !== input) applyPending.current = { input, key: crypto.randomUUID() };
      const result = await api.instantiate(selected, allocations, title.trim(), applyPending.current.key), draft = draftSchema.parse(result.draft);
      if (!live.current || ticket !== epoch.current) return;
      if (draft.maker !== address.toLowerCase() || draft.templatePin?.templateId !== selected.template.templateId ||
        draft.templatePin?.version !== selected.template.version || draft.templatePin?.digest !== selected.digest || canonical(draft.allocations) !== canonical(allocations)) throw new Error('instance mismatch');
      applyPending.current = null; await onApply({ ...result, draft });
    } catch (e) {
      if (e instanceof BuilderError && e.status >= 400 && e.status < 500) applyPending.current = null;
      fail(e);
    } finally { if (live.current && ticket === epoch.current) setBusy(''); }
  }
  async function withdraw() {
    if (!selected || busy || !withdrawChecked) return;
    const ticket = epoch.current; setBusy('Confirm withdrawal in your wallet'); setError('');
    try {
      if (!withdrawPending.current) {
        const signature = await signMessage(withdrawalMessage(window.location.origin, 11155111, selected.template));
        if (!live.current || ticket !== epoch.current) return;
        withdrawPending.current = { signature, key: crypto.randomUUID() };
      }
      const saved = await api.withdraw(selected, withdrawPending.current.signature, withdrawPending.current.key);
      const verified = await verifyPublishedTemplate(saved, selected.template.templateId, selected.template.version, selected.digest);
      if (!live.current || ticket !== epoch.current) return;
      setSelected(verified); withdrawPending.current = null;
      setItems(list => list.map(t => t.templateId === selected.template.templateId && t.version === selected.template.version ? { ...t, withdrawnAt: verified.withdrawnAt } : t));
    } catch (e) { fail(e); }
    finally { if (live.current && ticket === epoch.current) setBusy(''); }
  }
  const unavailable = selected && (selected.withdrawnAt || !selected.currentManifest || !selected.template.spec.deadline || selected.template.spec.deadline * 1000 <= Date.now());
  return <BuilderDialog title="Choose a published strategy" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!selected ? <div className={styles.catalog}>
      <p>Select a specific version, add your liquidity amounts and refine the settings its provider made editable.</p>
      {!items.length && <p>{busy || 'No published strategies are available yet.'}</p>}
      {items.map(item => <button className={styles.templateCard} key={`${item.templateId}-${item.version}`} disabled={!!busy} onClick={() => void choose(item)}>
        <span>{item.baseToken.symbol} / {item.quoteToken.symbol} · {item.model === 'concentrated' ? 'CLMM' : item.model.toUpperCase()}</span><strong>{item.title}</strong>
        <small>Version {item.version} · {item.withdrawnAt ? 'Withdrawn' : item.deadline * 1000 <= Date.now() ? 'Expired' : 'Available'} · Provider {item.provider.slice(0, 8)}…{item.provider.slice(-4)}</small>
      </button>)}
    </div> : <div className={styles.catalogDetail}>
      <button disabled={!!busy || !!applyPending.current || !!withdrawPending.current} onClick={() => { epoch.current++; setSelected(null); setError(''); }}>← Back to versions</button>
      <h3>{selected.template.spec.title} <span>Version {selected.template.version}</span></h3><p>Provider signature verified. Your liquidity remains pinned to this version if the provider publishes an update.</p>
      <StrategyDetails spec={selected.template.spec} requirements={selected.template.requirements} />
      <details><summary>Provider and editable settings</summary><p className={styles.address}>{selected.template.provider}</p><ul>
        <li>Personal title and liquidity amounts may be changed</li><li>{selected.template.permissions.tightenCaps ? 'May tighten the four public swap limits' : 'The four public swap limits are fixed'}</li>
        <li>{selected.template.permissions.shortenDeadline ? 'The deadline may be shortened' : 'The deadline is fixed'}</li>
        {selected.template.spec.model?.kind === 'concentrated' && <li>{selected.template.permissions.narrowConcentratedRange ? 'The original CLMM range may be narrowed' : 'The CLMM range is fixed'}</li>}
        {selected.template.spec.model?.kind === 'pegged' && <><li>Reference price: {selected.template.permissions.peggedReferencePrice ? `${selected.template.permissions.peggedReferencePrice.min}–${selected.template.permissions.peggedReferencePrice.max}` : 'Fixed'}</li><li>Amplification: {selected.template.permissions.peggedAmplification ? `${selected.template.permissions.peggedAmplification.min}–${selected.template.permissions.peggedAmplification.max}` : 'Fixed'}</li></>}
        <li>The pair, curve type, fee and other program settings are fixed</li></ul></details>
      {unavailable ? <p className={styles.notice}>{selected.withdrawnAt ? 'The provider withdrew this version.' : 'This version has expired or uses unsupported contracts.'} New liquidity cannot use it, but you can still inspect its settings.</p> : <>
        <h4>Your liquidity</h4><fieldset disabled={!!busy || !!applyPending.current}><div className={styles.formGrid}>
          <label>{selected.template.spec.baseToken!.symbol} allocation<input aria-label={`${selected.template.spec.baseToken!.symbol} Maker allocation`} inputMode="decimal" value={baseAmount} onChange={e => setBaseAmount(e.target.value)} maxLength={80} /></label>
          <label>{selected.template.spec.quoteToken!.symbol} allocation<input aria-label={`${selected.template.spec.quoteToken!.symbol} Maker allocation`} inputMode="decimal" value={quoteAmount} onChange={e => setQuoteAmount(e.target.value)} maxLength={80} /></label>
        </div><label>Personal strategy title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /></label></fieldset>
        {selected.template.spec.model?.kind === 'concentrated' && selected.template.spec.model.relativeWidthBps && <p className={styles.notice}>Application fixes the range using Kraken ETH/USDC as the test-token reference. The range will not automatically track the market.</p>}
        <p className={styles.helper}>Enter WETH rather than native ETH. Creating this draft does not transfer tokens or enable trading.</p>
        <button className={styles.primary} disabled={!!busy || !baseAmount || !quoteAmount || !title.trim()} onClick={() => void apply()}>{busy || (applyPending.current ? 'Retry creating this draft' : 'Use this version')}</button>
      </>}
      {selected.template.provider === address.toLowerCase() && !selected.withdrawnAt && <div className={styles.withdraw}>
        <h4>Withdraw this version</h4><p>Stop new liquidity from using this version. Existing drafts, history and onchain authorizations remain unchanged.</p>
        <label className={styles.checkbox}><input type="checkbox" checked={withdrawChecked} disabled={!!busy} onChange={e => setWithdrawChecked(e.target.checked)} />I understand that withdrawing this version does not revoke existing trading authorizations</label>
        <button disabled={!!busy || !withdrawChecked || !!applyPending.current} onClick={() => void withdraw()}>{withdrawPending.current ? 'Retry withdrawal confirmation' : 'Sign and withdraw version'}</button>
      </div>}
    </div>}
    {busy && <p role="status" className={styles.helper}>{busy}</p>}
  </BuilderDialog>;
}
