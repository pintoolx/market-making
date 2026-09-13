'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import { BuilderError, type BuilderClient, type Draft } from './client';
import { evidenceLabel, simulationState, verifyCompilation, verifyInventory,
  type Compilation, type CompilationItem, type InventoryResult, type SimulationDetail, type SimulationItem } from './preparation';
import BuilderDialog from './BuilderDialog';
import styles from './builder.module.css';

const active = (run: SimulationItem) => ['pending', 'running'].includes(run.state);
const stateLabel = { shipped: 'Registered', docked: 'Docked', 'unregistered-for-pair': 'Not registered for this pair', 'inconsistent-pair': 'Inconsistent pair state' };
const units = (value: string, decimals: number) => formatUnits(BigInt(value), decimals);

/** Read-only preparation and isolated background jobs. This component has no wallet signer. */
export default function MakerPreparation({ api, draft, onClose, onSessionExpired }: {
  api: BuilderClient; draft: Draft; onClose(): void; onSessionExpired(): void;
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [inventory, setInventory] = useState<InventoryResult | null>(null), [artifact, setArtifact] = useState<Compilation | null>(null);
  const [artifacts, setArtifacts] = useState<CompilationItem[]>([]), [runs, setRuns] = useState<SimulationItem[]>([]), [detail, setDetail] = useState<SimulationDetail | null>(null);
  const live = useRef(true), working = useRef(false), refreshEpoch = useRef(0);
  const compileKey = useRef<string | null>(null), simulationKey = useRef<string | null>(null), cancelKeys = useRef(new Map<string, string>());
  const fail = useCallback((e: unknown) => {
    if (!live.current) return;
    if (e instanceof BuilderError && e.status === 401) { onSessionExpired(); return; }
    if (e instanceof BuilderError && e.status === 409) setStale(true);
    setError(e instanceof BuilderError ? e.message : 'These results could not be verified against this draft. Reload before checking again.');
  }, [onSessionExpired]);
  const load = useCallback(async () => {
    const ticket = ++refreshEpoch.current;
    const [saved, compiled, simulations] = await Promise.all([api.draft(draft.id), api.compilations(draft.id), api.simulations(draft.id)]);
    if (!live.current || ticket !== refreshEpoch.current) return;
    const changed = saved.draft.revision !== draft.revision || saved.draft.owner !== draft.owner;
    const current = !changed && compiled.artifacts.find(a => Number(a.revision) === draft.revision && a.manifestHash === digestJson(profile));
    const selected = current ? verifyCompilation(await api.compilation(current.artifactId), draft, current.artifactId) : null;
    if (!live.current || ticket !== refreshEpoch.current) return;
    setStale(changed); setArtifacts(compiled.artifacts); setArtifact(selected); setRuns(simulations.simulations);
    setDetail(value => value && simulations.simulations.some(r => r.id === value.id && r.state === value.state && r.current === value.current) ? value : null);
  }, [api, draft]);
  useEffect(() => {
    live.current = true; setBusy('Loading preparation history');
    void load().catch(fail).finally(() => { if (live.current) setBusy(''); });
    return () => { live.current = false; };
  }, [load, fail]);
  const pending = runs.some(active);
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
  return <BuilderDialog title="Maker inventory and swap simulation" onClose={onClose}>
    <div className={styles.preparation}>
      <p>{draft.spec.title} · Draft v{draft.revision} · Ethereum Sepolia</p>
      <p>Read inventory, verify compilation and check settlement in an isolated environment. These checks do not request asset signatures or submit onchain transactions.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <p className={styles.notice}>The draft has changed. These are historical records. Close this dialog and open preparation from the latest strategy.</p>}
      {busy && <p role="status">{busy}</p>}
      <button disabled={!!busy} onClick={() => void act('Refresh preparation history', load)}>Refresh preparation history</button>
      <section aria-label="Maker inventory checks"><h3>1. Wallet and Aqua inventory</h3>
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
            {inventory.inventory.strategies.map(s => <div key={s.strategyHash}><p className={styles.address}>{s.strategyHash}</p><p>{stateLabel[s.state]}{s.selectedByGuard ? ' · Selected by Guard' : ''}</p>
              <ul>{s.balances.map(b => { const t = inventory.inventory.tokens.find(t => t.address === b.token)!; return <li key={b.token}>{t.symbol}: virtual inventory {units(b.virtualBalanceAtomic, t.decimals)}; inventory/balance/allowance capacity {units(b.inventoryAndAllowanceCapacityAtomic, t.decimals)}</li>; })}</ul></div>)}
            {!inventory.inventory.strategies.length && <p>No known strategy hashes are available. The wallet may still have other capital commitments.</p>}
            {inventory.knownArtifactsTruncated && <p>The compiled history exceeds the read limit. Showing up to 40 known hashes plus the hash selected by Guard.</p>}
          </details>
          <p className={styles.notice}>Strategies share the same wallet funds; their capacities cannot be added together. Ship records virtual inventory without depositing funds. Dock does not revoke allowances. These reads do not prove uncommitted funds or trading authorization. Recheck before signing.</p>
        </div>}
      </section>
      <section aria-label="Strategy compilation"><h3>2. Compile and decode</h3><p>Compilation binds the current allocations, draft revision and deployment profile. Recheck after editing or restoring a strategy.</p>
        <button disabled={!!busy || stale} onClick={() => void act('Compiling and verifying program', compile)}>{compileKey.current ? 'Retry compilation confirmation' : 'Compile current draft'}</button>
        {artifact && <div className={styles.compilationResult}><strong>Current v{draft.revision} compilation saved</strong><p>{artifact.payload.decoded.kind} · Zero fee · Guard checks every swap</p>
          <dl><dt>Program hash</dt><dd>{artifact.payload.programHash}</dd><dt>Order / Aqua strategy hash</dt><dd>{artifact.payload.strategyHash}</dd><dt>Guard</dt><dd>{artifact.payload.decoded.guard}</dd></dl>
          <details><summary>View instructions and program</summary><ol>{artifact.payload.decoded.instructions.map(i => <li key={i.pc}>{i.name} · opcode 0x{i.opcode.toString(16).padStart(2, '0')}</li>)}</ol><pre>{artifact.payload.program}</pre></details>
          <p>The server checks curve parameters; this view also verifies the revision, hashes, Guard and public limits. Compilation alone does not establish that all requirements are met or that trading is authorized.</p></div>}
        {!!artifacts.length && <details><summary>Compilation history ({artifacts.length})</summary><ul>{artifacts.map(a => <li key={a.artifactId}>v{a.revision} · {a.artifactId === artifact?.artifactId && !stale ? 'Current version' : 'Historical record; not valid for current registration'}</li>)}</ul></details>}
      </section>
      <section aria-label="Swap simulation"><h3>3. Background swap simulation</h3>
        <p>An isolated fork uses synthetic funds and authorization to test both directions, limits, revocation and docking. It does not verify TEE policy execution or sufficient live balances.</p>
        <button className={styles.primary} disabled={!!busy || stale || !artifact || (pending && !simulationKey.current)} onClick={() => void act('Scheduling background simulation', simulate)}>{simulationKey.current ? 'Retry simulation confirmation' : 'Simulate current compilation'}</button>
        {!runs.length && <p>No simulation history yet. Compile the current Maker draft first.</p>}
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
      <p className={styles.notice}>Next, verify each requirement, configure private Maker limits and approve event management before reviewing approve/ship transactions. These steps are not connected yet; preparation results do not enable trading.</p>
    </div>
  </BuilderDialog>;
}
