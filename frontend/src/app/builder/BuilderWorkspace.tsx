'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatUnits } from 'viem';
import { builderClient, BuilderError, type Conversation, type Draft, type Message, type Revision, type Validation, type TemplateContext } from './client';
import TemplatePublisher from './TemplatePublisher';
import TemplateCatalog from './TemplateCatalog';
import MakerPreparation from './MakerPreparation';
import type { Account } from '../providers/useAccount';
import styles from './builder.module.css';

type Identity = Pick<Account, 'ready' | 'enabled' | 'authenticated' | 'address' | 'userId' | 'login' | 'signMessage' | 'getAccessToken'>;
const curveNames = { xyc: '一般乘積', concentrated: '固定區間 CLMM', pegged: '錨定曲線' };
const fields: Record<string, string> = { 'spec.baseToken': '基礎幣種', 'spec.quoteToken': '報價幣種', 'spec.model': '做市曲線',
  'spec.model.minPrice': '價格下限', 'spec.model.maxPrice': '價格上限', 'spec.model.referencePrice': '參考價格',
  'spec.model.amplification': '放大係數', 'spec.model.fixedSnapshotRange': '套用時的固定價格', 'spec.feeBps': 'LP 費率',
  'spec.deadline': '策略期限', 'spec.guardEnvelope': '公開 Guard 上限', 'spec.title': '策略名稱', 'requirements': '策略條件',
  'spec.guardEnvelope.maxAmountBasePerSwap': '單筆基礎幣上限', 'spec.guardEnvelope.maxAmountQuotePerSwap': '單筆報價幣上限',
  'spec.guardEnvelope.maxPostBalanceBase': '成交後基礎幣庫存上限', 'spec.guardEnvelope.maxPostBalanceQuote': '成交後報價幣庫存上限',
  'maker': 'Maker 錢包', 'allocations': 'Maker 配置', 'allocations.baseAtomic': '基礎幣配置', 'allocations.quoteAtomic': '報價幣配置' };
const toolNames: Record<string, string> = { inspectStrategy: '讀取策略與版本', getCapabilities: '核對可用功能', resolveTokens: '核對交易對',
  createOrPatchDraft: '保存策略變更', validateStrategy: '驗證公開設定', exportStrategy: '整理公開策略', compileStrategy: '編譯並核對策略',
  getWalletInventory: '讀取錢包資產', previewScenarios: '計算成交情境', simulateLifecycle: '安排成交模擬' };
const amount = (value?: string, decimals?: number) => value && decimals !== undefined ? formatUnits(BigInt(value), decimals) : '尚未設定';
function valueLabel(path: string, value: unknown, draft: Draft) {
  if (value === null || value === undefined) return '未設定';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `${value.length} 項條件`;
    if ('symbol' in value) return String(value.symbol);
    if ('kind' in value) {
      const model = value as NonNullable<Draft['spec']['model']>;
      return `${curveNames[model.kind] ?? model.kind}${model.kind === 'concentrated' && model.minPrice && model.maxPrice ? ` · ${model.minPrice}–${model.maxPrice}` : ''}`;
    }
    return `${Object.keys(value).length} 項設定`;
  }
  if (path.includes('guardEnvelope.') && typeof value === 'string') {
    const token = path.endsWith('Base') || path.includes('BasePerSwap') ? draft.spec.baseToken : draft.spec.quoteToken;
    return `${amount(value, token?.decimals)} ${token?.symbol ?? ''}`;
  }
  if (path === 'spec.feeBps') return `${Number(value) / 100}%`;
  return String(value);
}
function MarkdownText({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: () => null,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</Markdown></div>;
}

/** The identity comes from Privy in the application; fixtures may supply a local test identity. */
export default function BuilderWorkspace({ identity }: { identity: Identity }) {
  const api = useRef<ReturnType<typeof builderClient> | null>(null), epoch = useRef(0), selectedRef = useRef<Conversation | null>(null);
  const messageArea = useRef<HTMLDivElement>(null), followLatest = useRef(true), newDraftKey = useRef<string | null>(null);
  const [connected, setConnected] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]), [selected, setSelected] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null), [messages, setMessages] = useState<Message[]>([]), [history, setHistory] = useState<Revision[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null), [input, setInput] = useState('');
  const [turnId, setTurnId] = useState<string | null>(null), [provisional, setProvisional] = useState(''), [activity, setActivity] = useState('');
  const [pollKey, setPollKey] = useState(0), [historyOpen, setHistoryOpen] = useState(false);
  const [publisherOpen, setPublisherOpen] = useState(false), [catalogOpen, setCatalogOpen] = useState(false), [templateContext, setTemplateContext] = useState<TemplateContext | null>(null);
  const [preparationOpen, setPreparationOpen] = useState(false);
  const pending = useRef<{ content: string; revision: number; conversationId: string; key: string } | null>(null);

  useEffect(() => {
    epoch.current++; api.current = null; selectedRef.current = null; pending.current = null; newDraftKey.current = null;
    setConnected(false); setSelected(null); setDraft(null); setMessages([]); setHistory([]); setValidation(null);
    setConversations([]); setTurnId(null); setProvisional(''); setBusy(''); setError('');
    setPublisherOpen(false); setCatalogOpen(false); setTemplateContext(null);
    setPreparationOpen(false);
  }, [identity.address, identity.userId, identity.authenticated]);
  useEffect(() => { if (followLatest.current && messageArea.current) messageArea.current.scrollTop = messageArea.current.scrollHeight; }, [messages, provisional]);

  const failure = useCallback((error: unknown, fallback: string) => {
    setError(error instanceof BuilderError ? error.message : fallback);
    if (error instanceof BuilderError && error.status === 401) {
      epoch.current++; api.current = null; setConnected(false); setTurnId(null); setProvisional(''); setBusy('');
    }
  }, []);
  const sessionExpired = useCallback(() => failure(new BuilderError(401, 'authentication-required'), ''), [failure]);

  async function refresh() {
    const client = api.current, current = selectedRef.current, ticket = epoch.current;
    if (!client || !current) return;
    const [d, m, h, v, list] = await Promise.all([client.draft(current.draftId), client.messages(current.conversationId),
      client.history(current.draftId), client.validate(current.draftId), client.list()]);
    if (ticket !== epoch.current || api.current !== client) return;
    const context = d.draft.templatePin ? await client.templateContext(d.draft.id, d.draft.revision) : null;
    if (ticket !== epoch.current || api.current !== client) return;
    setTemplateContext(context);
    setDraft(d.draft); setMessages(m.messages); setHistory(h.revisions); setValidation(v); setConversations(list.conversations);
    return list.conversations.find(c => c.conversationId === current.conversationId);
  }
  async function choose(conversation: Conversation) {
    const client = api.current; if (!client) return;
    const ticket = ++epoch.current;
    followLatest.current = true;
    selectedRef.current = conversation; setSelected(conversation); setTurnId(null); setProvisional('');
    setDraft(null); setMessages([]); setHistory([]); setValidation(null); setError(''); setBusy('載入策略'); pending.current = null;
    setPublisherOpen(false); setCatalogOpen(false); setTemplateContext(null);
    setPreparationOpen(false);
    try { await refresh(); if (epoch.current === ticket) setTurnId(conversation.activeTurnId); }
    catch (e) { if (epoch.current === ticket) failure(e, '無法載入策略，請重試。'); }
    finally { if (epoch.current === ticket) setBusy(''); }
  }
  async function create() {
    const client = api.current; if (!client) return;
    const ticket = epoch.current; setBusy('建立草稿'); setError('');
    try {
      newDraftKey.current ??= crypto.randomUUID();
      const result = await client.create('我的做市策略', newDraftKey.current);
      if (ticket !== epoch.current) return;
      newDraftKey.current = null;
      await choose({ conversationId: result.conversationId, draftId: result.draft.id, title: result.draft.spec.title, revision: '1', activeTurnId: null });
    } catch (e) { if (ticket === epoch.current) { setBusy(''); failure(e, '無法建立草稿。'); } }
  }
  async function connect() {
    if (!identity.address || !identity.getAccessToken || !identity.signMessage) return;
    const ticket = epoch.current, client = builderClient({ address: identity.address, getAccessToken: identity.getAccessToken, signMessage: identity.signMessage });
    setBusy('請在錢包確認登入簽名'); setError('');
    try {
      await client.connect(); const list = await client.list();
      if (ticket !== epoch.current) return;
      api.current = client; setConnected(true); setConversations(list.conversations); setBusy('');
      if (list.conversations[0]) await choose(list.conversations[0]); else await create();
    } catch (e) { if (ticket === epoch.current) { setBusy(''); failure(e, '錢包驗證未完成，請再次確認登入簽名。'); } }
  }

  useEffect(() => {
    if (!turnId || !api.current) return;
    const client = api.current, ticket = epoch.current;
    let disposed = false, cursor = '0', timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !disposed && epoch.current === ticket;
    const poll = async () => {
      try {
        const page = await client.events(turnId, cursor);
        if (!valid()) return;
        let changed = false;
        for (const event of page.events) {
          cursor = event.sequence;
          if (event.kind === 'started') { setProvisional(''); setActivity('正在思考你的策略'); }
          if (event.kind === 'text') setProvisional(text => text + (event.payload.text ?? ''));
          if (event.kind === 'tool') { setActivity(toolNames[event.payload.name ?? ''] ?? '檢查策略'); changed = true; }
        }
        const { turn } = await client.turn(turnId);
        if (!valid()) return;
        if (!['queued', 'running'].includes(turn.state)) {
          await refresh(); if (!valid()) return;
          setTurnId(null); setProvisional(''); setActivity('');
          if (turn.state === 'failed') setError('這輪回覆未完成。已保存的修改仍在右側，你可以繼續調整。');
          if (turn.state === 'superseded') setError('策略已由其他操作更新，已載入最新版本。');
          return;
        }
        if (changed) await refresh();
        if (valid()) timer = setTimeout(poll, page.events.length === 100 ? 0 : 700);
      } catch (e) { if (valid()) failure(e, '回覆連線中斷，請重新載入。'); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
    // refresh reads the current scope from refs; a selection change increments epoch.
  }, [turnId, pollKey, failure]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const client = api.current, current = selectedRef.current, content = input.trim();
    if (!client || !current || !draft || !content || turnId || busy) return;
    if (/(?:sk-proj-|sk-[A-Za-z0-9]{20}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/.test(content)) {
      setError('請移除私鑰或 API key。對話只適合公開策略參數。'); return;
    }
    const ticket = epoch.current;
    followLatest.current = true;
    if (!pending.current || pending.current.content !== content || pending.current.revision !== draft.revision || pending.current.conversationId !== current.conversationId) {
      pending.current = { content, revision: draft.revision, conversationId: current.conversationId, key: crypto.randomUUID() };
    }
    setBusy('送出訊息'); setError('');
    try {
      const result = await client.start(current.conversationId, draft.revision, content, pending.current.key);
      if (ticket !== epoch.current) return;
      setInput(''); pending.current = null; await refresh();
      if (ticket === epoch.current) { setTurnId(result.id); setActivity('正在讀取策略'); }
    } catch (e) { if (ticket === epoch.current) failure(e, '訊息未送出，可以重試。'); }
    finally { if (ticket === epoch.current) setBusy(''); }
  }
  async function restore(revision: number) {
    const client = api.current; if (!client || !draft || turnId || busy) return;
    const ticket = epoch.current; setBusy('恢復版本'); setError('');
    try { await client.restore(draft.id, draft.revision, revision, crypto.randomUUID()); await refresh(); }
    catch (e) { if (ticket === epoch.current) failure(e, '未能恢復版本。'); }
    finally { if (ticket === epoch.current) setBusy(''); }
  }
  const retry = async () => { const ticket = epoch.current; setError(''); try {
    const current = await refresh();
    if (ticket !== epoch.current) return;
    if (current) {
      setTurnId(current.activeTurnId); setProvisional('');
      if (current.activeTurnId && pending.current?.conversationId === current.conversationId) {
        const acceptedContent = pending.current.content;
        setInput(value => value === acceptedContent ? '' : value); pending.current = null;
      }
    }
    setPollKey(n => n + 1);
  } catch (e) { if (ticket === epoch.current) failure(e, '仍無法連線，請稍後重試。'); } };
  const stop = async () => {
    if (!api.current || !turnId) return;
    const ticket = epoch.current;
    try { await api.current.cancel(turnId); if (ticket === epoch.current) { setProvisional(''); setPollKey(n => n + 1); } }
    catch (e) { if (ticket === epoch.current) failure(e, '尚未確認停止，請重試。'); }
  };
  const caps = draft?.spec.guardEnvelope, base = draft?.spec.baseToken, quote = draft?.spec.quoteToken, model = draft?.spec.model;

  return <section className={styles.workspace} aria-label="策略設計工作區">
    <header className={styles.heading}><div><span className={styles.eyebrow}>{draft?.kind === 'maker' ? 'MAKER' : 'PROVIDER'} / STRATEGY BUILDER</span><h1>把你的想法，變成策略。</h1><p>先說明目標，再一起微調每個條件。</p></div><span className={styles.network}>Ethereum Sepolia</span></header>
    {error && <div className={styles.error} role="alert"><p>{error}</p>{connected && <button onClick={() => void retry()}>重新載入</button>}</div>}
    {!connected ? <div className={styles.welcome}>
      <div><span className={styles.eyebrow}>從你的目標開始</span><h2>不必一次想好<br />所有參數。</h2><p>比較做市曲線、訂下交易上限，或回到前一個版本。每次修改都會保留記錄。</p>
        <button className={styles.primary} disabled={!!busy || !identity.ready || !identity.enabled || (identity.authenticated && !identity.address)} onClick={identity.authenticated ? () => void connect() : identity.login}>
          {busy || (!identity.enabled ? '登入服務尚未開放' : identity.authenticated ? '驗證錢包並開始設計' : '登入並開始設計')}
        </button><small>登入簽名只用來確認錢包身分，不授權資產轉移。</small>
      </div><div className={styles.example}><span>你可以這樣開始</span><blockquote>「我想做 WETH / USDC 的流動性，價格超出我能接受的範圍就不成交。先幫我比較做法。」</blockquote><p>目標 → 方案比較 → 持續調整 → 檢查與模擬</p></div>
    </div> : <>
      <div className={styles.toolbar}><label>我的草稿<select aria-label="選擇策略草稿" value={selected?.conversationId ?? ''} disabled={!!busy} onChange={event => { const c = conversations.find(x => x.conversationId === event.target.value); if (c) void choose(c); }}>
        {!conversations.length && <option value="">尚無草稿</option>}{conversations.map(c => <option key={c.conversationId} value={c.conversationId}>{c.title}{c.activeTurnId ? ' · 回覆中' : ''}</option>)}
      </select></label><button onClick={() => void create()} disabled={!!busy}>＋ 新增草稿</button><button disabled={!!busy || !!turnId} onClick={() => setCatalogOpen(true)}>選擇模板套用</button><span className={styles.saved}>{busy || (draft ? `已保存 · v${draft.revision}` : '準備開始')}</span></div>
      <div className={styles.columns}>
        <section className={styles.chat} aria-label="策略對話"><div className={styles.sectionHead}><h2>一起設計</h2><span>公開策略參數</span></div>
          <div ref={messageArea} className={styles.messages} onScroll={event => {
            const el = event.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}>
            {!messages.length && !busy && <div className={styles.emptyChat}><h3>你希望策略做到什麼？</h3><p>先談目標與取捨，之後還能隨時調整。</p>{['比較固定區間與一般乘積曲線', '我想限制每筆成交與庫存', '哪些條件可以交給 Guard？'].map(text => <button key={text} onClick={() => setInput(text)}>{text} ↗</button>)}</div>}
            {messages.map(message => <article key={message.id} className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}><span className={styles.author}>{message.role === 'user' ? '你' : 'Pintool'}</span><MarkdownText text={message.content} /></article>)}
            {provisional && <article className={styles.assistantMessage} aria-busy="true"><span className={styles.author}>Pintool · 回覆中</span><MarkdownText text={provisional} /></article>}
          </div>
          <form className={styles.composer} onSubmit={submit}><label htmlFor="strategy-message">描述目標或這次想調整的地方</label><textarea id="strategy-message" value={input} onChange={e => setInput(e.target.value)} maxLength={8000} rows={3} placeholder="例如：只把價格上限改成 2700，保留其他限制。" disabled={!draft || !!busy} />
            <div className={styles.composerBottom}><span role="status" aria-live="polite">{turnId ? activity || '正在回覆' : '私密規則請在獨立編輯器設定。'}</span>{turnId ? <button type="button" onClick={() => void stop()}>停止生成</button> : <button className={styles.primary} type="submit" disabled={!draft || !input.trim() || !!busy}>送出 ↗</button>}</div>
          </form>
        </section>
        <aside className={styles.strategy} aria-label="目前策略"><div className={styles.sectionHead}><h2>目前策略</h2><span className={styles.draftTag}>{draft?.kind === 'maker' ? 'Maker 草稿 · 未註冊' : 'Provider 設計草稿'}</span></div>
          {draft ? <>
            <div className={styles.strategyTitle}><h3>{draft.spec.title}</h3><p>{base?.symbol ?? '待選幣種'} / {quote?.symbol ?? '待選幣種'}<span>{model ? curveNames[model.kind] : '尚未選擇曲線'}</span></p></div>
            {draft.kind === 'maker' && <div className={styles.makerInstance}><h3>你的配置</h3><p>{amount(draft.allocations?.baseAtomic, base?.decimals)} {base?.symbol} ＋ {amount(draft.allocations?.quoteAtomic, quote?.decimals)} {quote?.symbol}</p>
              {templateContext && <><p>綁定 Provider 模板版本 {templateContext.templatePin.version}；可以繼續對話調整允許的參數，Provider 更新不會改變你的版本。</p>
                <details><summary>查看可調範圍</summary><ul><li>可調整個人名稱與配置</li><li>{templateContext.permissions.tightenCaps ? '可收緊原始四項 Guard 上限' : '四項 Guard 上限固定'}</li>
                  <li>{templateContext.permissions.shortenDeadline ? '可縮短原始策略期限' : '策略期限固定'}</li>
                  {templateContext.baseline.model?.kind === 'concentrated' && <li>{templateContext.permissions.narrowConcentratedRange ? '可縮小' : '固定於'}原始範圍 {templateContext.baseline.model.minPrice}–{templateContext.baseline.model.maxPrice}</li>}
                  <li>交易對、曲線種類與費率固定</li></ul></details>
                {templateContext.withdrawn && <p className={styles.notice}>Provider 已撤下此版本，不能新增套用。這不代表既有鏈上授權已撤銷。</p>}</>}
              <small>草稿配置尚未驗證錢包餘額與 allowance，也尚未註冊或啟用成交。</small></div>}
            {model?.kind === 'concentrated' && <div className={styles.range}><span>固定成交價格區間 · {quote?.symbol ?? 'quote'} / {base?.symbol ?? 'base'}</span><div><strong>{model.minPrice ?? '—'}</strong><i aria-hidden="true" /><strong>{model.maxPrice ?? '—'}</strong></div><small>{model.relativeWidthBps ? `套用時依參考價格 ±${model.relativeWidthBps / 100}% 固定區間` : '區間不會自動跟隨市場移動'}</small></div>}
            <dl className={styles.facts}><dt>LP 費率</dt><dd>{draft.spec.feeBps === undefined ? '尚未設定' : `${draft.spec.feeBps / 100}%`}</dd><dt>策略期限</dt><dd>{draft.spec.deadline ? new Date(draft.spec.deadline * 1000).toLocaleString('zh-TW') : '尚未設定'}</dd>{model?.kind === 'pegged' && <><dt>參考價格</dt><dd>{model.referencePrice ?? '尚未設定'}</dd><dt>放大係數</dt><dd>{model.amplification ?? '尚未設定'}</dd></>}</dl>
            <div className={styles.guard}><h3>Guard 公開上限</h3><p>每筆成交檢查；這些不是每日累計額度。</p><table><thead><tr><th scope="col">幣種</th><th scope="col">每筆最多</th><th scope="col">成交後庫存</th></tr></thead><tbody>
              <tr><th scope="row">{base?.symbol ?? '基礎幣'}</th><td>{amount(caps?.maxAmountBasePerSwap, base?.decimals)}</td><td>{amount(caps?.maxPostBalanceBase, base?.decimals)}</td></tr>
              <tr><th scope="row">{quote?.symbol ?? '報價幣'}</th><td>{amount(caps?.maxAmountQuotePerSwap, quote?.decimals)}</td><td>{amount(caps?.maxPostBalanceQuote, quote?.decimals)}</td></tr>
            </tbody></table></div>
            <div className={styles.requirements}><h3>你訂下的條件 <span>{draft.requirements.length}</span></h3>{draft.requirements.length ? <ul>{draft.requirements.map(r => <li key={r.id}><span>{r.priority === 'must' ? '必要' : '偏好'}</span>{r.text}</li>)}</ul> : <p>確認的目標與限制會保存在這裡。</p>}</div>
            {validation?.revision === draft.revision && <div className={styles.validation} data-ready={validation.ready}><strong>{validation.ready ? '公開設定完整' : '還需要一起確認'}</strong>{validation.ready ? <p>{draft.kind === 'maker' ? '可以繼續編譯與模擬。配置、需求與實際成交條件仍須逐項驗證。' : '可以審閱並發布設計模板。Maker 套用後仍需編譯、模擬及需求驗證。'}</p> : <ul>{validation.missingFields.map(f => <li key={f}>{fields[f] ?? '其他必要設定'}</li>)}{validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}</div>}
            {draft.kind === 'template' && <div className={styles.publishAction}><button className={styles.primary} disabled={!!busy || !!turnId || !validation?.ready || validation.revision !== draft.revision} onClick={() => setPublisherOpen(true)}>私密政策與模板發布</button>
              <p>規則在獨立表單設定並加密，發布由錢包確認。</p></div>}
            {draft.kind === 'maker' && <div className={styles.publishAction}><button className={styles.primary} disabled={!!busy || !!turnId} onClick={() => setPreparationOpen(true)}>資產、編譯與成交模擬</button>
              <p>檢查這個版本的資產與模擬結果，再繼續調整。</p></div>}
            <div className={styles.history}><button className={styles.historyToggle} onClick={() => setHistoryOpen(v => !v)} aria-expanded={historyOpen}>版本與變更 <span>{historyOpen ? '−' : '+'}</span></button>
              {historyOpen && history.map(revision => <div key={revision.revision} className={styles.revision}><div><strong>v{revision.revision}</strong><time>{new Date(revision.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</time>{Number(revision.revision) < draft.revision && <button disabled={!!busy || !!turnId} onClick={() => void restore(Number(revision.revision))}>恢復此版本</button>}</div>
                {revision.diff.length ? <ul>{revision.diff.map((d, i) => <li key={i}><span>{fields[d.path] ?? '策略設定'}</span>{valueLabel(d.path, d.before, draft)} → {valueLabel(d.path, d.after, draft)}</li>)}</ul> : <p>建立草稿</p>}
              </div>)}
              {historyOpen && <p>恢復會建立新版本，保留原本的修改紀錄。</p>}
            </div>
          </> : <div className={styles.emptySummary}>策略的曲線、上限與每次變更，會出現在這裡。</div>}
        </aside>
      </div>
      {publisherOpen && draft?.kind === 'template' && api.current && identity.signMessage && <TemplatePublisher key={`${identity.address}-${draft.id}-${draft.revision}`} api={api.current} draft={draft} signMessage={identity.signMessage} onClose={() => { setPublisherOpen(false); void retry(); }} onSessionExpired={sessionExpired} />}
      {preparationOpen && draft?.kind === 'maker' && api.current && <MakerPreparation key={`${identity.address}-${draft.id}-${draft.revision}`} api={api.current} draft={draft} onClose={() => { setPreparationOpen(false); void retry(); }} onSessionExpired={sessionExpired} />}
      {catalogOpen && api.current && identity.address && identity.signMessage && <TemplateCatalog key={identity.address} api={api.current} address={identity.address} signMessage={identity.signMessage} onClose={() => { setCatalogOpen(false); void retry(); }} onSessionExpired={sessionExpired} onApply={async result => {
        await choose({ conversationId: result.conversationId, draftId: result.draft.id, title: result.draft.spec.title, revision: String(result.draft.revision), activeTurnId: null });
      }} />}
    </>}
  </section>;
}
