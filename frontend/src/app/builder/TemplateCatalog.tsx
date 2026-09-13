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
  const [busy, setBusy] = useState('載入模板'), [error, setError] = useState(''), [withdrawChecked, setWithdrawChecked] = useState(false);
  const live = useRef(true), epoch = useRef(0), applyPending = useRef<{ input: string; key: string } | null>(null);
  const withdrawPending = useRef<{ signature: `0x${string}`; key: string } | null>(null);
  useEffect(() => {
    live.current = true;
    void api.templates().then(result => { if (live.current) setItems(result.templates); }).catch(e => {
      if (!live.current) return;
      if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
      setError(e instanceof BuilderError ? e.message : '無法載入模板。');
    })
      .finally(() => { if (live.current) setBusy(''); });
    return () => { live.current = false; };
  }, [api, onSessionExpired]);
  const fail = (e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    setError(e instanceof BuilderError ? e.message : '版本或輸入未能核對，請檢查數量後重試。');
  };
  async function choose(item: TemplateItem) {
    const ticket = ++epoch.current; setBusy('核對 Provider 簽名'); setError(''); setSelected(null);
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
    const ticket = epoch.current; setBusy('建立 Maker 草稿'); setError('');
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
    const ticket = epoch.current; setBusy('請在錢包確認撤下'); setError('');
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
  return <BuilderDialog title="選擇 Provider 模板" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!selected ? <div className={styles.catalog}>
      <p>選定不可變版本，建立自己的 Maker 草稿後，還能繼續用對話微調。</p>
      {!items.length && <p>{busy || '目前尚無已發布的模板。先設計並發布自己的版本，也可以自己套用。'}</p>}
      {items.map(item => <button className={styles.templateCard} key={`${item.templateId}-${item.version}`} disabled={!!busy} onClick={() => void choose(item)}>
        <span>{item.baseToken.symbol} / {item.quoteToken.symbol} · {item.model === 'concentrated' ? 'CLMM' : item.model.toUpperCase()}</span><strong>{item.title}</strong>
        <small>版本 {item.version} · {item.withdrawnAt ? '已撤下' : item.deadline * 1000 <= Date.now() ? '期限已到' : '可查看並套用'} · Provider {item.provider.slice(0, 8)}…{item.provider.slice(-4)}</small>
      </button>)}
    </div> : <div className={styles.catalogDetail}>
      <button disabled={!!busy || !!applyPending.current || !!withdrawPending.current} onClick={() => { epoch.current++; setSelected(null); setError(''); }}>← 返回版本列表</button>
      <h3>{selected.template.spec.title} <span>版本 {selected.template.version}</span></h3><p>Provider 簽名已核對。版本綁定後，不會自動更新成其他版本。</p>
      <StrategyDetails spec={selected.template.spec} requirements={selected.template.requirements} />
      <details><summary>Maker 可調範圍與 Provider 身分</summary><p className={styles.address}>{selected.template.provider}</p><ul>
        <li>可更改個人標題與資產配置</li><li>{selected.template.permissions.tightenCaps ? '可收緊四項 Guard 上限' : '四項 Guard 上限固定'}</li>
        <li>{selected.template.permissions.shortenDeadline ? '可縮短期限' : '期限固定'}</li>
        {selected.template.spec.model?.kind === 'concentrated' && <li>{selected.template.permissions.narrowConcentratedRange ? '可縮小原始 CLMM 範圍' : 'CLMM 範圍固定'}</li>}
        {selected.template.spec.model?.kind === 'pegged' && <><li>參考價格：{selected.template.permissions.peggedReferencePrice ? `${selected.template.permissions.peggedReferencePrice.min}–${selected.template.permissions.peggedReferencePrice.max}` : '固定'}</li><li>放大係數：{selected.template.permissions.peggedAmplification ? `${selected.template.permissions.peggedAmplification.min}–${selected.template.permissions.peggedAmplification.max}` : '固定'}</li></>}
        <li>交易對、曲線種類、費率及其他程式設定固定</li></ul></details>
      {unavailable ? <p className={styles.notice}>{selected.withdrawnAt ? 'Provider 已撤下這個版本。' : '此版本期限或部署設定已不適用。'}不能新增套用，版本仍保留供查看。</p> : <>
        <h4>你的 Maker 配置</h4><fieldset disabled={!!busy || !!applyPending.current}><div className={styles.formGrid}>
          <label>{selected.template.spec.baseToken!.symbol} 配置<input aria-label={`${selected.template.spec.baseToken!.symbol} Maker 配置`} inputMode="decimal" value={baseAmount} onChange={e => setBaseAmount(e.target.value)} maxLength={80} /></label>
          <label>{selected.template.spec.quoteToken!.symbol} 配置<input aria-label={`${selected.template.spec.quoteToken!.symbol} Maker 配置`} inputMode="decimal" value={quoteAmount} onChange={e => setQuoteAmount(e.target.value)} maxLength={80} /></label>
        </div><label>個人策略名稱<input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /></label></fieldset>
        {selected.template.spec.model?.kind === 'concentrated' && selected.template.spec.model.relativeWidthBps && <p className={styles.notice}>套用時會用 Kraken ETH/USDC 行情作為測試幣的參考，固定本次上下界；之後不會自動跟價。</p>}
        <p className={styles.helper}>配置用 WETH 數量計算，ETH 不能直接算入 WETH。建立草稿不會轉移 token；後續需確認餘額、編譯、模擬及錢包操作。加密政策尚待可信工作流程驗證。</p>
        <button className={styles.primary} disabled={!!busy || !baseAmount || !quoteAmount || !title.trim()} onClick={() => void apply()}>{busy || (applyPending.current ? '重試建立同一份草稿' : '套用並繼續設計')}</button>
      </>}
      {selected.template.provider === address.toLowerCase() && !selected.withdrawnAt && <div className={styles.withdraw}>
        <h4>撤下這個版本</h4><p>停止新 Maker 套用，既有草稿與歷史仍保留。此操作不可復原，也不會自行撤銷既有鏈上 standing 授權。</p>
        <label className={styles.checkbox}><input type="checkbox" checked={withdrawChecked} disabled={!!busy} onChange={e => setWithdrawChecked(e.target.checked)} />我了解這只會撤下此版本，既有成交授權需另行撤銷</label>
        <button disabled={!!busy || !withdrawChecked || !!applyPending.current} onClick={() => void withdraw()}>{withdrawPending.current ? '重試確認撤下' : '錢包簽名並撤下版本'}</button>
      </div>}
    </div>}
    {busy && <p role="status" className={styles.helper}>{busy}</p>}
  </BuilderDialog>;
}
