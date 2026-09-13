'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatUnits } from 'viem';
import { builderClient, BuilderError, type Conversation, type Draft, type Message, type Revision, type Validation, type TemplateContext, type RequirementReceipt } from './client';
import TemplatePublisher from './TemplatePublisher';
import TemplateCatalog from './TemplateCatalog';
import MakerPreparation from './MakerPreparation';
import RequirementReviewDialog from './RequirementReviewDialog';
import type { Account } from '../providers/useAccount';
import styles from './builder.module.css';

type Identity = Pick<Account, 'ready' | 'enabled' | 'authenticated' | 'address' | 'userId' | 'login' | 'signMessage' | 'getAccessToken'>;
const curveNames = { xyc: 'Constant product', concentrated: 'Fixed-range CLMM', pegged: 'Pegged curve' };
const fields: Record<string, string> = { 'spec.baseToken': 'Base token', 'spec.quoteToken': 'Quote token', 'spec.model': 'Market-making curve',
  'spec.model.minPrice': 'Minimum price', 'spec.model.maxPrice': 'Maximum price', 'spec.model.referencePrice': 'Reference price',
  'spec.model.amplification': 'Amplification', 'spec.model.fixedSnapshotRange': 'Price fixed at application', 'spec.feeBps': 'LP fee',
  'spec.deadline': 'Strategy deadline', 'spec.guardEnvelope': 'Public Guard limits', 'spec.title': 'Strategy name', 'requirements': 'Strategy requirements',
  'spec.guardEnvelope.maxAmountBasePerSwap': 'Base-token limit per swap', 'spec.guardEnvelope.maxAmountQuotePerSwap': 'Quote-token limit per swap',
  'spec.guardEnvelope.maxPostBalanceBase': 'Post-swap base inventory limit', 'spec.guardEnvelope.maxPostBalanceQuote': 'Post-swap quote inventory limit',
  'maker': 'Maker wallet', 'allocations': 'Maker allocation', 'allocations.baseAtomic': 'Base allocation', 'allocations.quoteAtomic': 'Quote allocation' };
const toolNames: Record<string, string> = { inspectStrategy: 'Reading strategy and revisions', getCapabilities: 'Checking available capabilities', resolveTokens: 'Verifying token pair',
  createOrPatchDraft: 'Saving strategy changes', validateStrategy: 'Validating public parameters', exportStrategy: 'Preparing public strategy', compileStrategy: 'Compiling and verifying strategy',
  getWalletInventory: 'Reading wallet inventory', previewScenarios: 'Calculating swap scenarios', simulateLifecycle: 'Scheduling swap simulation', prepareRegistration: 'Preparing registration transaction', prepareCancellation: 'Preparing cancellation transaction' };
const amount = (value?: string, decimals?: number) => value && decimals !== undefined ? formatUnits(BigInt(value), decimals) : 'Not set';
function valueLabel(path: string, value: unknown, draft: Draft) {
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `${value.length} requirements`;
    if ('symbol' in value) return String(value.symbol);
    if ('kind' in value) {
      const model = value as NonNullable<Draft['spec']['model']>;
      return `${curveNames[model.kind] ?? model.kind}${model.kind === 'concentrated' && model.minPrice && model.maxPrice ? ` · ${model.minPrice}–${model.maxPrice}` : ''}`;
    }
    return `${Object.keys(value).length} settings`;
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
  const [requirementReviewOpen, setRequirementReviewOpen] = useState(false), [requirementReceipt, setRequirementReceipt] = useState<RequirementReceipt | null>(null);
  const [preparationOpen, setPreparationOpen] = useState(false);
  const pending = useRef<{ content: string; revision: number; conversationId: string; key: string } | null>(null);

  useEffect(() => {
    epoch.current++; api.current = null; selectedRef.current = null; pending.current = null; newDraftKey.current = null;
    setConnected(false); setSelected(null); setDraft(null); setMessages([]); setHistory([]); setValidation(null);
    setConversations([]); setTurnId(null); setProvisional(''); setBusy(''); setError('');
    setPublisherOpen(false); setCatalogOpen(false); setTemplateContext(null);
    setRequirementReviewOpen(false); setRequirementReceipt(null);
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
    const receipt = d.draft.requirements.length ? await client.requirementReview(d.draft) : null;
    if (ticket !== epoch.current || api.current !== client) return;
    setRequirementReceipt(receipt);
    setDraft(d.draft); setMessages(m.messages); setHistory(h.revisions); setValidation(v); setConversations(list.conversations);
    return list.conversations.find(c => c.conversationId === current.conversationId);
  }
  async function choose(conversation: Conversation) {
    const client = api.current; if (!client) return;
    const ticket = ++epoch.current;
    followLatest.current = true;
    selectedRef.current = conversation; setSelected(conversation); setTurnId(null); setProvisional('');
    setDraft(null); setMessages([]); setHistory([]); setValidation(null); setError(''); setBusy('Loading strategy'); pending.current = null;
    setPublisherOpen(false); setCatalogOpen(false); setTemplateContext(null);
    setPreparationOpen(false);
    setRequirementReviewOpen(false);
    try { await refresh(); if (epoch.current === ticket) setTurnId(conversation.activeTurnId); }
    catch (e) { if (epoch.current === ticket) failure(e, 'Could not load the strategy. Please retry.'); }
    finally { if (epoch.current === ticket) setBusy(''); }
  }
  async function create() {
    const client = api.current; if (!client) return;
    const ticket = epoch.current; setBusy('Create draft'); setError('');
    try {
      newDraftKey.current ??= crypto.randomUUID();
      const result = await client.create('My market-making strategy', newDraftKey.current);
      if (ticket !== epoch.current) return;
      newDraftKey.current = null;
      await choose({ conversationId: result.conversationId, draftId: result.draft.id, title: result.draft.spec.title, revision: '1', activeTurnId: null });
    } catch (e) { if (ticket === epoch.current) { setBusy(''); failure(e, 'Could not create the draft.'); } }
  }
  async function connect() {
    if (!identity.address || !identity.getAccessToken || !identity.signMessage) return;
    const ticket = epoch.current, client = builderClient({ address: identity.address, getAccessToken: identity.getAccessToken, signMessage: identity.signMessage });
    setBusy('Confirm the sign-in message in your wallet'); setError('');
    try {
      await client.connect(); const list = await client.list();
      if (ticket !== epoch.current) return;
      api.current = client; setConnected(true); setConversations(list.conversations); setBusy('');
      if (list.conversations[0]) await choose(list.conversations[0]); else await create();
    } catch (e) { if (ticket === epoch.current) { setBusy(''); failure(e, 'Wallet verification was not completed. Please confirm the sign-in message again.'); } }
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
          if (event.kind === 'started') { setProvisional(''); setActivity('Reviewing your strategy'); }
          if (event.kind === 'text') setProvisional(text => text + (event.payload.text ?? ''));
          if (event.kind === 'tool') { setActivity(toolNames[event.payload.name ?? ''] ?? 'Checking strategy'); changed = true; }
        }
        const { turn } = await client.turn(turnId);
        if (!valid()) return;
        if (!['queued', 'running'].includes(turn.state)) {
          await refresh(); if (!valid()) return;
          setTurnId(null); setProvisional(''); setActivity('');
          if (turn.state === 'failed') setError('This response did not finish. Saved changes remain in the strategy panel; you can keep editing.');
          if (turn.state === 'superseded') setError('Another action updated this strategy. The latest version is now loaded.');
          return;
        }
        if (changed) await refresh();
        if (valid()) timer = setTimeout(poll, page.events.length === 100 ? 0 : 700);
      } catch (e) { if (valid()) failure(e, 'The response connection was interrupted. Please reload.'); }
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
      setError('Remove private keys or API keys. Use this conversation for public strategy parameters only.'); return;
    }
    const ticket = epoch.current;
    followLatest.current = true;
    if (!pending.current || pending.current.content !== content || pending.current.revision !== draft.revision || pending.current.conversationId !== current.conversationId) {
      pending.current = { content, revision: draft.revision, conversationId: current.conversationId, key: crypto.randomUUID() };
    }
    setBusy('Sending message'); setError('');
    try {
      const result = await client.start(current.conversationId, draft.revision, content, pending.current.key);
      if (ticket !== epoch.current) return;
      setInput(''); pending.current = null; await refresh();
      if (ticket === epoch.current) { setTurnId(result.id); setActivity('Reading strategy'); }
    } catch (e) { if (ticket === epoch.current) failure(e, 'Your message was not sent. Please retry.'); }
    finally { if (ticket === epoch.current) setBusy(''); }
  }
  async function restore(revision: number) {
    const client = api.current; if (!client || !draft || turnId || busy) return;
    const ticket = epoch.current; setBusy('Restoring revision'); setError('');
    try { await client.restore(draft.id, draft.revision, revision, crypto.randomUUID()); await refresh(); }
    catch (e) { if (ticket === epoch.current) failure(e, 'Could not restore this revision.'); }
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
  } catch (e) { if (ticket === epoch.current) failure(e, 'Still unable to connect. Please try again shortly.'); } };
  const stop = async () => {
    if (!api.current || !turnId) return;
    const ticket = epoch.current;
    try { await api.current.cancel(turnId); if (ticket === epoch.current) { setProvisional(''); setPollKey(n => n + 1); } }
    catch (e) { if (ticket === epoch.current) failure(e, 'Cancellation has not been confirmed. Please retry.'); }
  };
  const caps = draft?.spec.guardEnvelope, base = draft?.spec.baseToken, quote = draft?.spec.quoteToken, model = draft?.spec.model;

  return <section className={styles.workspace} aria-label="Strategy design workspace">
    <header className={styles.heading}><div><span className={styles.eyebrow}>{draft?.kind === 'maker' ? 'MAKER' : 'PROVIDER'} / STRATEGY BUILDER</span><h1>Turn your idea into a strategy.</h1><p>Start with your goals, then refine each condition together.</p></div><span className={styles.network}>Ethereum Sepolia</span></header>
    {error && <div className={styles.error} role="alert"><p>{error}</p>{connected && <button onClick={() => void retry()}>Reload</button>}</div>}
    {!connected ? <div className={styles.welcome}>
      <div><span className={styles.eyebrow}>Start with your goals</span><h2>You can refine <br />your parameters as you go.</h2><p>Compare curves, set trade limits and revisit earlier versions. Every change is recorded.</p>
        <button className={styles.primary} disabled={!!busy || !identity.ready || !identity.enabled || (identity.authenticated && !identity.address)} onClick={identity.authenticated ? () => void connect() : identity.login}>
          {busy || (!identity.enabled ? 'Sign-in is unavailable' : identity.authenticated ? 'Verify wallet and start designing' : 'Log in and start designing')}
        </button><small>Signing in verifies wallet ownership. It does not authorize asset transfers.</small>
      </div><div className={styles.example}><span>Try starting with</span><blockquote>“I want to provide WETH / USDC liquidity and stop trading outside my price range. Help me compare the options.”</blockquote><p>Goals → Compare → Refine → Verify and simulate</p></div>
    </div> : <>
      <div className={styles.toolbar}><label>My drafts<select aria-label="Select strategy draft" value={selected?.conversationId ?? ''} disabled={!!busy} onChange={event => { const c = conversations.find(x => x.conversationId === event.target.value); if (c) void choose(c); }}>
        {!conversations.length && <option value="">No drafts yet</option>}{conversations.map(c => <option key={c.conversationId} value={c.conversationId}>{c.title}{c.activeTurnId ? ' · Responding' : ''}</option>)}
      </select></label><button onClick={() => void create()} disabled={!!busy}>+ New draft</button><button disabled={!!busy || !!turnId} onClick={() => setCatalogOpen(true)}>Browse templates</button><span className={styles.saved}>{busy || (draft ? `Saved · v${draft.revision}` : 'Ready to start')}</span></div>
      <div className={styles.columns}>
        <section className={styles.chat} aria-label="Strategy conversation"><div className={styles.sectionHead}><h2>Design together</h2><span>Public strategy parameters</span></div>
          <div ref={messageArea} className={styles.messages} onScroll={event => {
            const el = event.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}>
            {!messages.length && !busy && <div className={styles.emptyChat}><h3>What should your strategy do?</h3><p>Start with goals and trade-offs. You can refine them later.</p>{['Compare fixed-range and constant-product curves', 'Help me set per-swap and inventory limits', 'Which conditions can Guard enforce?'].map(text => <button key={text} onClick={() => setInput(text)}>{text} ↗</button>)}</div>}
            {messages.map(message => <article key={message.id} className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}><span className={styles.author}>{message.role === 'user' ? 'You' : 'PinTool'}</span><MarkdownText text={message.content} /></article>)}
            {provisional && <article className={styles.assistantMessage} aria-busy="true"><span className={styles.author}>PinTool · Responding</span><MarkdownText text={provisional} /></article>}
          </div>
          <form className={styles.composer} onSubmit={submit}><label htmlFor="strategy-message">Describe your goals or what you want to change</label><textarea id="strategy-message" value={input} onChange={e => setInput(e.target.value)} maxLength={8000} rows={3} placeholder="For example: change only the maximum price to 2700 and keep the other limits." disabled={!draft || !!busy} />
            <div className={styles.composerBottom}><span role="status" aria-live="polite">{turnId ? activity || 'Responding' : 'Set private rules in the separate policy editor.'}</span>{turnId ? <button type="button" onClick={() => void stop()}>Stop generating</button> : <button className={styles.primary} type="submit" disabled={!draft || !input.trim() || !!busy}>Send ↗</button>}</div>
          </form>
        </section>
        <aside className={styles.strategy} aria-label="Current strategy"><div className={styles.sectionHead}><h2>Current strategy</h2><span className={styles.draftTag}>{draft?.kind === 'maker' ? 'Maker draft · Not registered' : 'Provider design draft'}</span></div>
          {draft ? <>
            <div className={styles.strategyTitle}><h3>{draft.spec.title}</h3><p>{base?.symbol ?? 'Choose token'} / {quote?.symbol ?? 'Choose token'}<span>{model ? curveNames[model.kind] : 'No curve selected'}</span></p></div>
            {draft.kind === 'maker' && <div className={styles.makerInstance}><h3>Your allocation</h3><p>{amount(draft.allocations?.baseAtomic, base?.decimals)} {base?.symbol} + {amount(draft.allocations?.quoteAtomic, quote?.decimals)} {quote?.symbol}</p>
              {templateContext && <><p>Pinned Provider template version {templateContext.templatePin.version}. Continue editing permitted parameters in chat. Provider updates do not change your pinned version.</p>
                <details><summary>View editable parameters</summary><ul><li>Personal title and allocations are editable</li><li>{templateContext.permissions.tightenCaps ? 'The four original Guard limits may be tightened' : 'The four Guard limits are fixed'}</li>
                  <li>{templateContext.permissions.shortenDeadline ? 'The original strategy deadline may be shortened' : 'The strategy deadline is fixed'}</li>
                  {templateContext.baseline.model?.kind === 'concentrated' && <li>{templateContext.permissions.narrowConcentratedRange ? 'May narrow' : 'Fixed at'} original range {templateContext.baseline.model.minPrice}–{templateContext.baseline.model.maxPrice}</li>}
                  <li>Token pair, curve type and fee are fixed</li></ul></details>
                {templateContext.withdrawn && <p className={styles.notice}>The Provider withdrew this version. New instances cannot use it; existing onchain authorizations are not automatically revoked.</p>}</>}
              <small>Draft allocations do not verify wallet balances or allowances, and do not register or enable trading.</small></div>}
            {model?.kind === 'concentrated' && <div className={styles.range}><span>Fixed trading range · {quote?.symbol ?? 'quote'} / {base?.symbol ?? 'base'}</span><div><strong>{model.minPrice ?? '—'}</strong><i aria-hidden="true" /><strong>{model.maxPrice ?? '—'}</strong></div><small>{model.relativeWidthBps ? `Range fixed at application to reference price ±${model.relativeWidthBps / 100}%` : 'The range does not automatically follow the market'}</small></div>}
            <dl className={styles.facts}><dt>LP fee</dt><dd>{draft.spec.feeBps === undefined ? 'Not set' : `${draft.spec.feeBps / 100}%`}</dd><dt>Strategy deadline</dt><dd>{draft.spec.deadline ? new Date(draft.spec.deadline * 1000).toLocaleString('en-US') : 'Not set'}</dd>{model?.kind === 'pegged' && <><dt>Reference price</dt><dd>{model.referencePrice ?? 'Not set'}</dd><dt>Amplification</dt><dd>{model.amplification ?? 'Not set'}</dd></>}</dl>
            <div className={styles.guard}><h3>Public Guard limits</h3><p>Checked on every swap. These are not daily cumulative limits.</p><table><thead><tr><th scope="col">Token</th><th scope="col">Maximum per swap</th><th scope="col">Post-swap inventory</th></tr></thead><tbody>
              <tr><th scope="row">{base?.symbol ?? 'Base token'}</th><td>{amount(caps?.maxAmountBasePerSwap, base?.decimals)}</td><td>{amount(caps?.maxPostBalanceBase, base?.decimals)}</td></tr>
              <tr><th scope="row">{quote?.symbol ?? 'Quote token'}</th><td>{amount(caps?.maxAmountQuotePerSwap, quote?.decimals)}</td><td>{amount(caps?.maxPostBalanceQuote, quote?.decimals)}</td></tr>
            </tbody></table></div>
<div className={styles.requirements}><h3>Your requirements <span>{draft.requirements.length}</span></h3>{draft.requirements.length ? <>
              <ul>{draft.requirements.map(r => <li key={r.id}><span>{r.priority === 'must' ? 'Required' : 'Preference'}</span>{r.text}{r.criteria?.length ? <small>Concrete interpretation ready for review</small> : <small>Agent interpretation still needed</small>}</li>)}</ul>
              <button disabled={!!busy || !!turnId} onClick={() => setRequirementReviewOpen(true)}>{requirementReceipt?.revision === draft.revision ? 'View requirement confirmation' : 'Confirm requirements'}</button>
              {requirementReceipt?.revision === draft.revision && <p className={styles.helper}>This revision has user-confirmed requirements. This does not establish an onchain report or registration.</p>}
            </> : <p>Confirmed goals and constraints are saved here.</p>}</div>
            {validation?.revision === draft.revision && <div className={styles.validation} data-ready={validation.ready}><strong>{validation.ready ? 'Public parameters complete' : 'More details needed'}</strong>{validation.ready ? <p>{draft.kind === 'maker' ? 'Ready for compilation and simulation. Allocations, requirements and execution conditions still need individual verification.' : 'Ready to review and publish a design template. Maker instances still require compilation, simulation and requirement checks.'}</p> : <ul>{validation.missingFields.map(f => <li key={f}>{fields[f] ?? 'Other required parameters'}</li>)}{validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}</div>}
            {draft.kind === 'template' && <div className={styles.publishAction}><button className={styles.primary} disabled={!!busy || !!turnId || !validation?.ready || validation.revision !== draft.revision || (draft.requirements.length > 0 && requirementReceipt?.revision !== draft.revision)} onClick={() => setPublisherOpen(true)}>Private policy and publication</button>
              <p>Configure and encrypt rules in a separate form, then confirm publication with your wallet.</p></div>}
            {draft.kind === 'maker' && <div className={styles.publishAction}><button className={styles.primary} disabled={!!busy || !!turnId || (draft.requirements.length > 0 && requirementReceipt?.revision !== draft.revision)} onClick={() => setPreparationOpen(true)}>Inventory, compilation and simulation</button>
              <p>Review inventory and simulation results for this version before refining it.</p></div>}
            <div className={styles.history}><button className={styles.historyToggle} onClick={() => setHistoryOpen(v => !v)} aria-expanded={historyOpen}>Versions and changes <span>{historyOpen ? '−' : '+'}</span></button>
              {historyOpen && history.map(revision => <div key={revision.revision} className={styles.revision}><div><strong>v{revision.revision}</strong><time>{new Date(revision.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time>{Number(revision.revision) < draft.revision && <button disabled={!!busy || !!turnId} onClick={() => void restore(Number(revision.revision))}>Restore this revision</button>}</div>
                {revision.diff.length ? <ul>{revision.diff.map((d, i) => <li key={i}><span>{fields[d.path] ?? 'Strategy parameters'}</span>{valueLabel(d.path, d.before, draft)} → {valueLabel(d.path, d.after, draft)}</li>)}</ul> : <p>Create draft</p>}
              </div>)}
              {historyOpen && <p>Restoring creates a new revision and preserves earlier changes.</p>}
            </div>
          </> : <div className={styles.emptySummary}>Your curve, limits and revision history will appear here.</div>}
        </aside>
      </div>
      {publisherOpen && draft?.kind === 'template' && api.current && identity.signMessage && <TemplatePublisher key={`${identity.address}-${draft.id}-${draft.revision}`} api={api.current} draft={draft} signMessage={identity.signMessage} onClose={() => { setPublisherOpen(false); void retry(); }} onSessionExpired={sessionExpired} />}
      {requirementReviewOpen && draft && api.current && <RequirementReviewDialog key={`${draft.id}-${draft.revision}`} api={api.current} draft={draft} onClose={() => setRequirementReviewOpen(false)} onComplete={() => { setRequirementReviewOpen(false); void retry(); }} />}
      {preparationOpen && draft?.kind === 'maker' && api.current && identity.signMessage && <MakerPreparation key={`${identity.address}-${draft.id}-${draft.revision}`} api={api.current} draft={draft} signMessage={identity.signMessage} onClose={() => { setPreparationOpen(false); void retry(); }} onSessionExpired={sessionExpired} />}
      {catalogOpen && api.current && identity.address && identity.signMessage && <TemplateCatalog key={identity.address} api={api.current} address={identity.address} signMessage={identity.signMessage} onClose={() => { setCatalogOpen(false); void retry(); }} onSessionExpired={sessionExpired} onApply={async result => {
        await choose({ conversationId: result.conversationId, draftId: result.draft.id, title: result.draft.spec.title, revision: String(result.draft.revision), activeTurnId: null });
      }} />}
    </>}
  </section>;
}
