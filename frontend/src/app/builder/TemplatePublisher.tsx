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
      setError(e instanceof BuilderError ? e.message : '無法載入既有模板。');
    });
    return () => { live.current = false; pending.current = null; prepare.current = null; };
  }, [api, draft.owner, onSessionExpired]);
  const clearReview = () => { setReview(null); setChecked(false); pending.current = null; };
  const failure = (e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    const rule = e instanceof PrivatePolicyError ? e.field.match(/^rules\.(\d+)/) : null;
    setError(e instanceof PrivatePolicyError ? `${rule ? `規則 ${Number(rule[1]) + 1}：` : ''}${e.message}` : e instanceof BuilderError ? e.message : '操作未完成，請檢查錢包或重新審閱。');
    if (e instanceof BuilderError && e.status === 409) { clearReview(); prepare.current = null; }
  };
  async function prepareReview() {
    if (!form || busy || !checked) return;
    setBusy('準備版本審閱'); setError('');
    try {
      // Validate before any network call. The final version ID is supplied by the server intent.
      encodePrivatePolicy(form, draft.spec, 'local-policy-validation');
      const checkedPermissions = templatePermissionsSchema.safeParse(permissions);
      if (!checkedPermissions.success) throw new PrivatePolicyError('permissions', '請檢查公開調整範圍的上下限與數字格式。');
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
    setBusy(pending.current ? '確認發布結果' : '請在錢包簽署版本'); setError('');
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
  return <BuilderDialog title="發布 Provider 模板" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {published ? <div className={styles.publicationComplete}><span className={styles.eyebrow}>VERSION PUBLISHED</span><h3>{published.template.spec.title} · 版本 {published.template.version}</h3>
      <p>模板已保存，Maker 現在可以選定此版本建立自己的草稿。私密表單已清除。</p><p>加密政策尚待可信工作流程驗證；發布不會註冊 LP 或授權成交。</p><button className={styles.primary} onClick={onClose}>回到策略</button></div> : <>
      <section className={styles.publicReview}><span className={styles.eyebrow}>PUBLIC VERSION</span><h3>{draft.spec.title}</h3><p>{base.symbol} / {quote.symbol} · 草稿 v{draft.revision} · 零費率</p>
        <StrategyDetails spec={draft.spec} requirements={draft.requirements} />
        <p>公開曲線、Guard 上限與需求會隨版本發布。Maker 之後仍需編譯、模擬與審閱自己的配置。</p>
        <fieldset disabled={!!busy || !!review}><label>發布到哪個模板<select value={templateId ?? ''} onChange={e => { setTemplateId(e.target.value || null); clearReview(); }}>
          <option value="">建立新模板</option>{series.map(t => <option key={t.templateId} value={t.templateId}>{t.title} · 目前版本 {t.version}</option>)}</select></label>
          <h4>Maker 可以調整的公開範圍</h4><div className={styles.checks}>
            <label><input type="checkbox" checked={permissions.tightenCaps} onChange={e => { setPermissions(p => ({ ...p, tightenCaps: e.target.checked })); clearReview(); }} />可收緊四項 Guard 上限</label>
            <label><input type="checkbox" checked={permissions.shortenDeadline} onChange={e => { setPermissions(p => ({ ...p, shortenDeadline: e.target.checked })); clearReview(); }} />可縮短策略期限</label>
            {draft.spec.model?.kind === 'concentrated' && <label><input type="checkbox" checked={permissions.narrowConcentratedRange} onChange={e => { setPermissions(p => ({ ...p, narrowConcentratedRange: e.target.checked })); clearReview(); }} />可縮小固定價格範圍</label>}
          </div>
          {draft.spec.model?.kind === 'pegged' && (['peggedReferencePrice', 'peggedAmplification'] as const).map(name => <div key={name}>
            <label className={styles.checkbox}><input type="checkbox" checked={!!permissions[name]} onChange={e => {
              const value = draft.spec.model?.kind === 'pegged' ? (name === 'peggedReferencePrice' ? draft.spec.model.referencePrice : draft.spec.model.amplification)! : '1';
              setPermissions(p => ({ ...p, [name]: e.target.checked ? { min: value, max: value } : null })); clearReview();
            }} />允許調整{name === 'peggedReferencePrice' ? '參考價格' : '放大係數'}</label>
            {permissions[name] && <div className={styles.formGrid}>{(['min', 'max'] as const).map(bound => <label key={bound}>{name === 'peggedReferencePrice' ? '參考價格' : '放大係數'}{bound === 'min' ? '下限' : '上限'}<input inputMode="decimal" value={permissions[name]![bound]} onChange={e => { setPermissions(p => ({ ...p, [name]: { ...p[name]!, [bound]: e.target.value } })); clearReview(); }} /></label>)}</div>}
          </div>)}
          <p className={styles.helper}>個人標題與配置可調整；交易對、曲線種類、費率及其他程式設定固定。所有可調上限都以這個發布版本為界。</p>
        </fieldset>
      </section>
      {form && <fieldset className={styles.privateFieldset} disabled={!!busy || !!review}><PrivatePolicyFields value={form} draft={draft} onChange={value => { setForm(value); clearReview(); }} /></fieldset>}
      {!review ? <div className={styles.dialogFooter}><label className={styles.checkbox}><input type="checkbox" checked={checked} disabled={!!busy} onChange={e => setChecked(e.target.checked)} />我已確認公開設定、可調範圍及上方私密規則</label>
        <button className={styles.primary} disabled={!checked || !!busy} onClick={() => void prepareReview()}>{busy || '加密並審閱版本'}</button></div> : <div className={styles.dialogFooter}>
        <p>即將發布版本 {review.intent.base.version}，私密規則已加密。請在錢包簽署完整公開版本；這份簽名不授權資產轉移。</p>
        <details><summary>查看錢包簽署內容</summary><pre>{review.message}</pre></details>
        <div className={styles.actions}><button disabled={!!busy || !!pending.current} onClick={() => { clearReview(); prepare.current = null; }}>返回修改</button>
          <button className={styles.primary} disabled={!!busy} onClick={() => void publish()}>{busy || (pending.current ? '重試確認發布' : '錢包簽名並發布')}</button></div>
      </div>}
    </>}
  </BuilderDialog>;
}
