'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import { BuilderError, type BuilderClient, type Draft, type AutomationConsent, type EventHealth, type EventSubscription, type AuthorizationBinding, type TransactionPlan, type ReportDelivery } from './client';
import { evidenceLabel, simulationState, verifyCompilation, verifyInventory,
  isReportEvidenceHash, isReportNonce, verifyTransactionPlan, type Compilation, type CompilationItem, type InventoryResult, type SimulationDetail, type SimulationItem } from './preparation';
import BuilderDialog from './BuilderDialog';
import styles from './builder.module.css';

const active = (run: SimulationItem) => ['pending', 'running'].includes(run.state);
const stateLabel = { shipped: 'Registered', docked: 'Docked', 'unregistered-for-pair': 'Not registered for this pair', 'inconsistent-pair': 'Inconsistent pair state' };
const units = (value: string, decimals: number) => formatUnits(BigInt(value), decimals);

/** Read-only preparation and isolated background jobs. It only requests explicit message signatures; asset transactions stay unsigned. */
export default function MakerPreparation({ api, draft, onClose, onSessionExpired, signMessage }: {
  api: BuilderClient; draft: Draft; onClose(): void; onSessionExpired(): void; signMessage(message: string): Promise<`0x${string}`>;
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [inventory, setInventory] = useState<InventoryResult | null>(null), [artifact, setArtifact] = useState<Compilation | null>(null);
  const [consent, setConsent] = useState<AutomationConsent | null>(null);
  const [subscription, setSubscription] = useState<EventSubscription | null>(null);
  const [eventHealth, setEventHealth] = useState<EventHealth[]>([]);
  const [deliveries, setDeliveries] = useState<ReportDelivery[]>([]);
  const [binding, setBinding] = useState<AuthorizationBinding | null>(null);
  const [reportDigest, setReportDigest] = useState(''), [reportTransactionHash, setReportTransactionHash] = useState(''), [reportNonce, setReportNonce] = useState('');
  const [registrationPlan, setRegistrationPlan] = useState<TransactionPlan | null>(null), [cancellationPlan, setCancellationPlan] = useState<TransactionPlan | null>(null);
  const [artifacts, setArtifacts] = useState<CompilationItem[]>([]), [runs, setRuns] = useState<SimulationItem[]>([]), [detail, setDetail] = useState<SimulationDetail | null>(null);
  const live = useRef(true), working = useRef(false), refreshEpoch = useRef(0);
  const compileKey = useRef<string | null>(null), simulationKey = useRef<string | null>(null), cancelKeys = useRef(new Map<string, string>());
  const bindingPrepareKey = useRef<string | null>(null), bindingIntent = useRef<{ id: string; message: string; digest: `0x${string}` } | null>(null);
  const bindingConfirmKey = useRef<string | null>(null), planKeys = useRef({ registration: null as string | null, cancellation: null as string | null });
  const fail = useCallback((e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    if (e instanceof BuilderError && e.status === 409) setStale(true);
    setError(e instanceof BuilderError ? e.message : 'These results could not be verified against this draft. Reload before checking again.');
  }, [onSessionExpired]);
  const load = useCallback(async () => {
    const ticket = ++refreshEpoch.current;
    const [saved, compiled, simulations, currentConsent, currentSubscription, currentBinding, health] = await Promise.all([api.draft(draft.id), api.compilations(draft.id), api.simulations(draft.id), api.automationConsent(draft), api.eventSubscription(draft), api.authorizationBinding(draft), api.eventHealth()]);
    if (!live.current || ticket !== refreshEpoch.current) return;
    const changed = saved.draft.revision !== draft.revision || saved.draft.owner !== draft.owner;
    const current = !changed && compiled.artifacts.find(a => Number(a.revision) === draft.revision && a.manifestHash === digestJson(profile));
    const selected = current ? verifyCompilation(await api.compilation(current.artifactId), draft, current.artifactId) : null;
    const reports = currentSubscription ? await api.eventDeliveries(currentSubscription.id) : { deliveries: [] };
    if (!live.current || ticket !== refreshEpoch.current) return;
    setDeliveries(reports.deliveries);
    setStale(changed); setArtifacts(compiled.artifacts); setArtifact(selected); setRuns(simulations.simulations); setConsent(currentConsent); setSubscription(currentSubscription); setBinding(currentBinding); setEventHealth(health.health);
    setDetail(value => value && simulations.simulations.some(r => r.id === value.id && r.state === value.state && r.current === value.current) ? value : null);
  }, [api, draft]);
  useEffect(() => {
    live.current = true; setBusy('Loading preparation history');
    void load().catch(fail).finally(() => { if (live.current) setBusy(''); });
    return () => { live.current = false; };
  }, [load, fail]);
  const pending = runs.some(active) || subscription?.state === 'enabled';
  useEffect(() => {
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout>, disposed = false;
    const poll = async () => {
      if (disposed) return;
      if (!working.current) { try { await load(); } catch (e) { fail(e); } }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [pending, load, fail]);
  async function act(label: string, work: () => Promise<void>) {
    if (working.current || busy) return;
    working.current = true; setBusy(label); setError('');
    try { await work(); } catch (e) { fail(e); }
    finally { working.current = false; if (live.current) setBusy(''); }
  }
  async function readInventory() {
    setInventory(null);
    const saved = verifyInventory(await api.inventory(draft), draft);
    if (live.current) setInventory(saved);
  }
  async function compile() {
    compileKey.current ??= crypto.randomUUID();
    const ref = await api.compile(draft, compileKey.current);
    if (!live.current) return;
    if (ref.draftId !== draft.id || ref.revision !== draft.revision) throw new Error('preparation-result-mismatch');
    await load(); if (live.current) compileKey.current = null;
  }
  async function simulate() {
    if (!artifact) return;
    simulationKey.current ??= crypto.randomUUID();
    const ref = await api.simulate(artifact.artifactId, draft.revision, simulationKey.current);
    if (!live.current) return;
    if (ref.artifactId !== artifact.artifactId || ref.draftId !== draft.id || ref.revision !== draft.revision) throw new Error('preparation-result-mismatch');
    await load(); if (live.current) simulationKey.current = null;
  }
  async function show(run: SimulationItem) {
    const saved = await api.simulation(run.id);
    if (!live.current) return;
    if (saved.id !== run.id || saved.draftId !== draft.id || saved.artifactId !== run.artifactId || saved.revision !== run.revision || saved.registrationReady !== false ||
      (saved.report && (saved.report.draftId !== draft.id || saved.report.revision !== run.revision || saved.report.registrationReady !== false ||
        !['mock', 'fork-with-overrides'].includes(saved.report.mode) || saved.report.passed !== saved.report.cases.every(c => c.passed !== false) ||
        saved.report.coverageComplete !== saved.report.cases.every(c => c.passed === true)))) throw new Error('preparation-result-mismatch');
    setDetail(saved);
  }
  async function bindGuardReport() {
    if (!artifact || stale) return;
    if (!isReportEvidenceHash(reportDigest) || !isReportEvidenceHash(reportTransactionHash) || !isReportNonce(reportNonce)) {
      setError('Enter a 32-byte report digest, transaction hash and a positive report nonce from the accepted Guard report.'); return;
    }
    bindingPrepareKey.current ??= crypto.randomUUID();
    let intent = bindingIntent.current;
    if (!intent) {
      const prepared = await api.prepareAuthorizationBinding(draft, artifact.artifactId, reportDigest as `0x${string}`, reportTransactionHash as `0x${string}`, reportNonce, bindingPrepareKey.current);
      intent = { id: prepared.intent.id, message: prepared.intent.message, digest: prepared.digest }; bindingIntent.current = intent;
    }
    setBusy('Confirm trusted Guard binding in your wallet');
    const signature = await signMessage(intent.message);
    bindingConfirmKey.current ??= crypto.randomUUID();
    const result = await api.confirmAuthorizationBinding(intent.id, intent.digest, signature, bindingConfirmKey.current);
    if (live.current) { setBinding(result.binding); bindingPrepareKey.current = null; bindingIntent.current = null; bindingConfirmKey.current = null; }
  }
  async function prepareWalletPlan(kind: TransactionPlan['kind']) {
    if (!artifact || stale) return;
    planKeys.current[kind] ??= crypto.randomUUID();
    const result = kind === 'registration'
      ? await api.prepareRegistration(draft, artifact.artifactId, planKeys.current.registration!)
      : await api.prepareCancellation(draft, artifact.artifactId, planKeys.current.cancellation!);
    const verified = verifyTransactionPlan(result, draft, artifact, kind).plan;
    if (live.current) {
      if (kind === 'registration') setRegistrationPlan(verified); else setCancellationPlan(verified);
      planKeys.current[kind] = null;
    }
  }
  async function enableAutomation() {
    if (!artifact || stale || (!binding && !draft.templatePin)) return;
    if (consent?.active) {
      await api.enableEventSubscription(draft, artifact.artifactId, consent.id, crypto.randomUUID());
      await load(); return;
    }
    const intent = await api.prepareAutomationConsent(draft, artifact.artifactId, crypto.randomUUID());
    setBusy('Confirm event-management consent in your wallet');
    const signature = await signMessage(intent.intent.message);
    const result = await api.confirmAutomationConsent(intent.intent.id, intent.digest, signature, crypto.randomUUID());
    await api.enableEventSubscription(draft, artifact.artifactId, result.consent.id, crypto.randomUUID());
    await load();
  }
  async function revokeAutomation() {
    if (!consent?.active) return;
    const message = ['Pintool Builder revoke automation consent v1', `consent: ${consent.id}`, `owner: ${consent.owner.slice(7)}`,
      `draft: ${consent.draftId}`, `strategyHash: ${consent.strategyHash}`, `scope: ${consent.scope}`].join('\n');
    setBusy('Confirm stopping event management in your wallet');
    await api.revokeAutomationConsent(consent.id, await signMessage(message), crypto.randomUUID());
    await load();
  }
  return <BuilderDialog title="Review liquidity and test execution" onClose={onClose}>
    <div className={styles.preparation}>
      <p>{draft.spec.title} · Draft v{draft.revision} · Ethereum Sepolia</p>
      <p>Check wallet capacity, verify the compiled strategy and test settlement before signing any asset transaction.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <p className={styles.notice}>The draft has changed. These are historical records. Close this dialog and open preparation from the latest strategy.</p>}
      {busy && <p role="status">{busy}</p>}
      <button disabled={!!busy} onClick={() => void act('Refresh preparation history', load)}>Refresh preparation history</button>
      <section aria-label="Maker inventory checks"><h3>1. Check wallet liquidity</h3>
        <button disabled={!!busy || stale} onClick={() => void act('Verifying onchain inventory', readInventory)}>Read current inventory</button>
        {inventory && <div className={styles.inventoryResult}>
          <strong>{evidenceLabel(inventory.inventory.mode)}</strong><p>Block {inventory.inventory.blockNumber} · {new Date(inventory.inventory.observedAt).toLocaleString('en-US')} · Not finalized</p>
          <p>Native ETH: {units(inventory.inventory.native.walletBalanceAtomic, 18)} (for gas; excluded from WETH allocations)</p>
          <div className={styles.tableScroll}><table><caption>Inventory and allowances at observation time</caption><thead><tr><th>Token</th><th>Maker allocation</th><th>Wallet balance</th><th>Aqua allowance</th></tr></thead><tbody>
            {inventory.inventory.tokens.map(t => {
              const amount = t.address === draft.spec.baseToken?.address ? draft.allocations?.baseAtomic : draft.allocations?.quoteAtomic;
              return <tr key={t.address}><th scope="row">{t.symbol}</th><td>{amount ? units(amount, t.decimals) : 'Not set'}</td>
                <td>{units(t.walletBalanceAtomic, t.decimals)}{amount && BigInt(t.walletBalanceAtomic) < BigInt(amount) && <small>Insufficient balance</small>}</td>
                <td>{units(t.allowanceToAquaAtomic, t.decimals)}{amount && BigInt(t.allowanceToAquaAtomic) < BigInt(amount) && <small>Insufficient allowance</small>}</td></tr>;
            })}</tbody></table></div>
          <details><summary>Known strategy virtual inventory ({inventory.inventory.strategies.length})</summary>
            {inventory.inventory.strategies.map(s => <div key={s.strategyHash}><p className={styles.address}>{s.strategyHash}</p><p>{stateLabel[s.state]}{s.selectedByGuard ? ' · Currently authorized' : ''}</p>
              <ul>{s.balances.map(b => { const t = inventory.inventory.tokens.find(t => t.address === b.token)!; return <li key={b.token}>{t.symbol}: virtual inventory {units(b.virtualBalanceAtomic, t.decimals)}; inventory/balance/allowance capacity {units(b.inventoryAndAllowanceCapacityAtomic, t.decimals)}</li>; })}</ul></div>)}
            {!inventory.inventory.strategies.length && <p>No known strategy hashes are available. The wallet may still have other capital commitments.</p>}
            {inventory.knownArtifactsTruncated && <p>Showing the 40 most recent compiled strategies plus the currently authorized strategy.</p>}
          </details>
          <p className={styles.notice}>Strategies share the same wallet funds; their capacities cannot be added together. Ship records virtual inventory without depositing funds. Dock does not revoke allowances. These reads do not prove uncommitted funds or trading authorization. Recheck before signing.</p>
        </div>}
      </section>
      <section aria-label="Strategy compilation"><h3>2. Compile the strategy</h3><p>Compilation binds this revision to its liquidity amounts and execution contracts. Recompile after changing or restoring the strategy.</p>
        <button disabled={!!busy || stale} onClick={() => void act('Compiling and verifying program', compile)}>{compileKey.current ? 'Retry compilation confirmation' : 'Compile current draft'}</button>
        {artifact && <div className={styles.compilationResult}><strong>Current v{draft.revision} compilation saved</strong><p>{artifact.payload.decoded.kind} · {artifact.payload.decoded.feeBps === 0 ? '0% fee' : `Fixed LP input fee · ${artifact.payload.decoded.feeBps} bps`} · Authorization checked on every swap</p>
          <dl><dt>Program hash</dt><dd>{artifact.payload.programHash}</dd><dt>Aqua strategy hash</dt><dd>{artifact.payload.strategyHash}</dd><dt>Authorization contract</dt><dd>{artifact.payload.decoded.guard}</dd></dl>
          <details><summary>View instructions and program</summary><ol>{artifact.payload.decoded.instructions.map(i => <li key={i.pc}>{i.name} · opcode 0x{i.opcode.toString(16).padStart(2, '0')}</li>)}</ol><pre>{artifact.payload.program}</pre></details>
          <p>PinTool verifies the curve, revision, program hashes, authorization contract and public limits. Compilation does not enable trading.</p></div>}
        {!!artifacts.length && <details><summary>Compilation history ({artifacts.length})</summary><ul>{artifacts.map(a => <li key={a.artifactId}>v{a.revision} · {a.artifactId === artifact?.artifactId && !stale ? 'Current version' : 'Historical record; not valid for current registration'}</li>)}</ul></details>}
      </section>
      <section aria-label="Swap simulation"><h3>3. Test swaps</h3>
        <p>An isolated fork uses synthetic funds and authorization to test both directions, limits, revocation and docking. It does not verify TEE policy execution or sufficient live balances.</p>
        <button className={styles.primary} disabled={!!busy || stale || !artifact || (pending && !simulationKey.current)} onClick={() => void act('Scheduling background simulation', simulate)}>{simulationKey.current ? 'Retry simulation confirmation' : 'Simulate current compilation'}</button>
        {!runs.length && <p>No simulation history yet. Compile the current liquidity draft first.</p>}
        {runs.map(run => <article key={run.id} className={styles.simulationCard}>
          <h4>v{run.revision} · {simulationState(run.state)}{!run.current || stale ? ' · Earlier revision' : ''}</h4>
          <p>{evidenceLabel(run.mode)}{run.mode ? ` · ${run.caseCount - run.skippedCaseCount} cases run out of ${run.caseCount}` : ''}</p>
          {run.mode && <p>{run.passed && run.coverageComplete ? 'All cases in this result passed. Requirements, policy and wallet checks remain.' : run.passed ? 'Some cases did not run. This is not a complete pass.' : 'Some cases failed. Refine the parameters in chat and retry.'}</p>}
          {!!run.issues.length && <ul>{run.issues.map(i => <li key={i.name}>{i.name}: {i.guidance}</li>)}</ul>}
          {run.errorCode && <p>Status reason: {run.errorCode}</p>}
          <div className={styles.actions}><button disabled={!!busy} onClick={() => void act('Loading cases', () => show(run))}>View v{run.revision} cases</button>
            {active(run) && <button disabled={!!busy} onClick={() => void act('Cancelling background simulation', async () => {
              if (!cancelKeys.current.has(run.id)) cancelKeys.current.set(run.id, crypto.randomUUID());
              await api.cancelSimulation(run.id, cancelKeys.current.get(run.id)!); if (live.current) await load();
            })}>Cancel v{run.revision} simulation</button>}</div>
        </article>)}
        {detail && <div className={styles.caseDetails}><h4>Case details · v{detail.revision}</h4><p>{simulationState(detail.state)} · {detail.current && !stale ? 'Current version' : 'Historical version'} · {evidenceLabel(detail.report?.mode ?? null)}</p>
          {detail.report ? <ul>{detail.report.cases.map(c => <li key={c.name}><span>{c.passed === null ? 'Not run' : c.passed ? 'Passed' : 'Failed'}</span> {c.name}{c.error ? ` · ${c.error}` : ''}</li>)}</ul> : <p>This job does not have complete results yet.</p>}
          <button onClick={() => setDetail(null)}>Hide cases</button></div>}
      </section>
      {!draft.templatePin && <section aria-label="Guard report binding"><h3>4. Verify Guard report binding</h3>
        <p>Provide the public digest, accepted transaction hash and report nonce from the latest Guard report. The service independently checks Sepolia RPC, Router, Guard, Maker, strategy and schema before creating a signing intent.</p>
        {binding && <div className={styles.consentResult}><strong>Guard report verified and Maker-bound</strong><p>Strategy hash: <span className={styles.address}>{binding.strategyHash}</span></p><p>Accepted report: <span className={styles.address}>{binding.reportTransactionHash}</span> · nonce {binding.reportNonce}</p><p>Binding digest: <span className={styles.address}>{binding.bindingDigest}</span></p><small>This message signature authorizes event report management for this exact revision. It does not approve tokens, ship, dock or send a transaction. Submit a newer accepted report below when the effective authorization changes.</small></div>}
        <fieldset disabled={!!busy || stale || !artifact}><label htmlFor="guard-report-digest">Report digest (32-byte hex)<input id="guard-report-digest" value={reportDigest} onChange={event => setReportDigest(event.target.value.trim())} placeholder="0x…" autoComplete="off" /></label>
            <label htmlFor="guard-report-transaction">Accepted report transaction hash<input id="guard-report-transaction" value={reportTransactionHash} onChange={event => setReportTransactionHash(event.target.value.trim())} placeholder="0x…" autoComplete="off" /></label>
            <label htmlFor="guard-report-nonce">Report nonce<input id="guard-report-nonce" inputMode="numeric" value={reportNonce} onChange={event => setReportNonce(event.target.value.replace(/[^0-9]/g, ''))} placeholder="1" autoComplete="off" /></label>
            <button className={styles.primary} disabled={!artifact || !!busy || stale || !isReportEvidenceHash(reportDigest) || !isReportEvidenceHash(reportTransactionHash) || !isReportNonce(reportNonce)} onClick={() => void act('Verifying Guard report evidence', bindGuardReport)}>{bindingIntent.current ? 'Retry Guard binding' : binding ? 'Verify newer report and sign binding' : 'Verify report and sign binding'}</button>
            <small>Only public report evidence belongs here. Never paste a private key, API key or policy input.</small></fieldset>
      </section>}
      <section aria-label="Event management consent"><h3>Event triggers and automatic report updates</h3>
        <p>Your signature enables evaluation of this exact strategy and Provider version. A new template instance queues its first report; later events request a report only when effective conditions change. Automatic updates do not swap, rebalance, approve, ship or dock assets. Consent expiry stops delivery and requires a new wallet signature.</p>
        {deliveries.length > 0 && <div className={styles.consentResult}><strong>Report delivery</strong><ul>{deliveries.map(report => <li key={report.id}>Nonce {report.nonce}: {report.status === 'broadcast' ? 'Awaiting verified chain receipt' : report.status === 'accepted' ? 'Accepted onchain' : report.status === 'pending' ? 'Queued' : 'Not delivered'}{report.transactionHash && isReportEvidenceHash(report.transactionHash) && <a href={`https://sepolia.etherscan.io/tx/${report.transactionHash}`} target="_blank" rel="noreferrer"> View transaction</a>}</li>)}</ul><small>Report acceptance and Aqua registration are separate. A pending or failed report does not authorize trading.</small></div>}
        {eventHealth.length > 0 && <div className={styles.consentResult}><strong>Event source monitoring</strong><ul>{eventHealth.map(source => <li key={source.source}>{source.source}: {source.health}{source.observedAt ? ` · last observed ${new Date(source.observedAt).toLocaleString('en-US')}` : ''}{source.errorCode ? ` · ${source.errorCode}` : ''}</li>)}</ul><small>Monitoring health describes the public event source. It does not revoke a standing Guard report or guarantee that a pause transaction was delivered.</small></div>}
        {consent?.active ? <div className={styles.consentResult}>{draft.templatePin && subscription?.state === 'enabled' && !subscription.lastEvaluatedAt && <p>First evaluation is queued. Report acceptance is pending.</p>}<strong>{subscription?.state === 'enabled' ? 'Event management enabled' : 'Consent is valid, but the event service is not enabled'}</strong><p>Consent expires: {new Date(consent.expiresAt).toLocaleString('en-US')} · Bound strategy hash: <span className={styles.address}>{consent.strategyHash}</span></p>{binding && <p>Guard report binding: {binding.reportTransactionHash} · nonce {binding.reportNonce}</p>}{subscription?.lastEvaluatedAt && <p>Last evaluation: {new Date(subscription.lastEvaluatedAt).toLocaleString('en-US')}{subscription.lastChangedAt ? ` · Last condition change: ${new Date(subscription.lastChangedAt).toLocaleString('en-US')}` : ''}</p>}{subscription?.state !== 'enabled' && <button disabled={!!busy || stale || !artifact} onClick={() => void act('Enabling event management', enableAutomation)}>Enable with current consent</button>}<button disabled={!!busy || stale} onClick={() => void act('Stopping event management', revokeAutomation)}>Stop automatic updates</button></div>
          : <div className={styles.consentResult}><p>{consent ? 'The previous consent expired or was stopped.' : 'Event management is not authorized.'}</p>{!binding && !draft.templatePin && <p className={styles.notice}>Complete trusted Guard report binding and Maker signature before enabling event triggers. The agent and this screen cannot substitute for that step.</p>}<button className={styles.primary} disabled={!!busy || stale || !artifact || (!binding && !draft.templatePin)} onClick={() => void act('Preparing event-management consent', enableAutomation)}>Enable automatic event updates</button><small>The current Maker wallet signs a message bound to this strategy revision. The service accepts only that signature and never receives the private key.</small></div>}
      </section>
      <section aria-label="Unsigned wallet plans"><h3>6. Review unsigned wallet plans</h3>
        <p>These plans contain exact ERC-20 approval, Aqua ship or Aqua dock calldata for the current artifact. They are unsigned and never broadcast here. A wallet must perform a fresh balance, allowance, chain and receipt preflight immediately before signing.</p>
        <div className={styles.actions}><button disabled={!!busy || stale || !artifact} onClick={() => void act('Preparing registration transaction plan', () => prepareWalletPlan('registration'))}>{planKeys.current.registration ? 'Retry registration plan' : 'Prepare approve and ship plan'}</button><button disabled={!!busy || stale || !artifact} onClick={() => void act('Preparing cancellation transaction plan', () => prepareWalletPlan('cancellation'))}>{planKeys.current.cancellation ? 'Retry cancellation plan' : 'Prepare dock plan'}</button></div>
        {registrationPlan && <div className={styles.planResult}><strong>Registration plan v{registrationPlan.revision}</strong><p>Strategy hash: <span className={styles.address}>{registrationPlan.strategyHash}</span></p><ol>{registrationPlan.transactions.map((transaction, index) => <li key={`${transaction.kind}-${index}`}><strong>{transaction.description}</strong><br /><span className={styles.address}>to {transaction.to}</span><details><summary>View calldata</summary><pre>{transaction.data}</pre></details></li>)}</ol><p className={styles.notice}>Prepared record only. Revalidate wallet state and every precondition before signing.</p></div>}
        {cancellationPlan && <div className={styles.planResult}><strong>Cancellation plan v{cancellationPlan.revision}</strong><p>Strategy hash: <span className={styles.address}>{cancellationPlan.strategyHash}</span></p><ol>{cancellationPlan.transactions.map((transaction, index) => <li key={`${transaction.kind}-${index}`}><strong>{transaction.description}</strong><br /><span className={styles.address}>to {transaction.to}</span><details><summary>View calldata</summary><pre>{transaction.data}</pre></details></li>)}</ol><p className={styles.notice}>Docking does not revoke ERC-20 allowances or alter a previously accepted Guard report.</p></div>}
      </section>
      <p className={styles.notice}>Asset transactions require your wallet. Automatic report updates require separate signed consent. Review registration and accepted report status before trading.</p>
    </div>
  </BuilderDialog>;
}
