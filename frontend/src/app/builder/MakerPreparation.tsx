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
const stateLabel = { shipped: '已登錄', docked: '已 dock', 'unregistered-for-pair': '尚未登錄此交易對', 'inconsistent-pair': '交易對狀態不一致' };
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
    setError(e instanceof BuilderError ? e.message : '結果與這份草稿無法核對，請重新載入後再檢查。');
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
    live.current = true; setBusy('載入準備紀錄');
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
  return <BuilderDialog title="Maker 資產與成交模擬" onClose={onClose}>
    <div className={styles.preparation}>
      <p>{draft.spec.title} · 草稿 v{draft.revision} · Ethereum Sepolia</p>
      <p>先讀取資產、核對編譯，再用隔離環境檢查成交。這裡不會請求資產簽名或送出鏈上交易。</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <p className={styles.notice}>草稿已更新。以下保留舊版紀錄；請關閉視窗，回到最新策略後再準備。</p>}
      {busy && <p role="status">{busy}</p>}
      <button disabled={!!busy} onClick={() => void act('更新準備紀錄', load)}>更新準備紀錄</button>
      <section aria-label="Maker 資產檢查"><h3>1. 錢包與 Aqua 庫存</h3>
        <button disabled={!!busy || stale} onClick={() => void act('核對鏈上資產', readInventory)}>讀取目前資產</button>
        {inventory && <div className={styles.inventoryResult}>
          <strong>{evidenceLabel(inventory.inventory.mode)}</strong><p>區塊 {inventory.inventory.blockNumber} · {new Date(inventory.inventory.observedAt).toLocaleString('zh-TW')} · 尚未 finalized</p>
          <p>原生 ETH：{units(inventory.inventory.native.walletBalanceAtomic, 18)}（gas 使用，不計入 WETH 配置）</p>
          <div className={styles.tableScroll}><table><caption>讀取當時的資產與 allowance</caption><thead><tr><th>幣種</th><th>Maker 配置</th><th>錢包餘額</th><th>Aqua allowance</th></tr></thead><tbody>
            {inventory.inventory.tokens.map(t => {
              const amount = t.address === draft.spec.baseToken?.address ? draft.allocations?.baseAtomic : draft.allocations?.quoteAtomic;
              return <tr key={t.address}><th scope="row">{t.symbol}</th><td>{amount ? units(amount, t.decimals) : '未設定'}</td>
                <td>{units(t.walletBalanceAtomic, t.decimals)}{amount && BigInt(t.walletBalanceAtomic) < BigInt(amount) && <small>餘額不足</small>}</td>
                <td>{units(t.allowanceToAquaAtomic, t.decimals)}{amount && BigInt(t.allowanceToAquaAtomic) < BigInt(amount) && <small>allowance 不足</small>}</td></tr>;
            })}</tbody></table></div>
          <details><summary>已知策略的虛擬庫存（{inventory.inventory.strategies.length}）</summary>
            {inventory.inventory.strategies.map(s => <div key={s.strategyHash}><p className={styles.address}>{s.strategyHash}</p><p>{stateLabel[s.state]}{s.selectedByGuard ? ' · Guard 目前選定' : ''}</p>
              <ul>{s.balances.map(b => { const t = inventory.inventory.tokens.find(t => t.address === b.token)!; return <li key={b.token}>{t.symbol}：虛擬庫存 {units(b.virtualBalanceAtomic, t.decimals)}；庫存／餘額／allowance 共同上限 {units(b.inventoryAndAllowanceCapacityAtomic, t.decimals)}</li>; })}</ul></div>)}
            {!inventory.inventory.strategies.length && <p>目前沒有可列出的已知 hash；這不代表錢包没有其他資金承諾。</p>}
            {inventory.knownArtifactsTruncated && <p>已知編譯紀錄超過讀取上限，只顯示其中 40 個 hash 與必要的 Guard 選定 hash。</p>}
          </details>
          <p className={styles.notice}>多個策略共用同一份錢包資金，不能加總可用上限。Ship 記錄虛擬庫存，不是入金；Dock 也不會撤銷 allowance。此讀取不證明資金尚未被其他用途占用，或已有可成交的 Guard 授權。簽名前仍須重新檢查。</p>
        </div>}
      </section>
      <section aria-label="策略編譯"><h3>2. 編譯與反解</h3><p>編譯綁定目前配置、草稿版本及部署設定。修改或恢復策略後，需用新版本重新檢查。</p>
        <button disabled={!!busy || stale} onClick={() => void act('編譯並核對程式', compile)}>{compileKey.current ? '重試確認編譯' : '編譯目前草稿'}</button>
        {artifact && <div className={styles.compilationResult}><strong>目前 v{draft.revision} 編譯已保存</strong><p>{artifact.payload.decoded.kind} · 零費率 · Guard 逐筆檢查</p>
          <dl><dt>Program hash</dt><dd>{artifact.payload.programHash}</dd><dt>Order／Aqua strategy hash</dt><dd>{artifact.payload.strategyHash}</dd><dt>Guard</dt><dd>{artifact.payload.decoded.guard}</dd></dl>
          <details><summary>查看實際指令與程式</summary><ol>{artifact.payload.decoded.instructions.map(i => <li key={i.pc}>{i.name} · opcode 0x{i.opcode.toString(16).padStart(2, '0')}</li>)}</ol><pre>{artifact.payload.program}</pre></details>
          <p>服務端已比較曲線參數，畫面另核對版本、hash、Guard 與公開上限。編譯成功不等於符合全部自然語言需求，也不表示已取得授權。</p></div>}
        {!!artifacts.length && <details><summary>編譯版本紀錄（{artifacts.length}）</summary><ul>{artifacts.map(a => <li key={a.artifactId}>v{a.revision} · {a.artifactId === artifact?.artifactId && !stale ? '目前版本' : '歷史紀錄，不可作為目前註冊依據'}</li>)}</ul></details>}
      </section>
      <section aria-label="成交模擬"><h3>3. 背景成交模擬</h3>
        <p>隔離 fork 使用合成資金與授權測試雙向成交、上限、撤銷和取消；不會驗證你的私密政策已經通過 TEE，也不表示真實餘額足夠。</p>
        <button className={styles.primary} disabled={!!busy || stale || !artifact || (pending && !simulationKey.current)} onClick={() => void act('安排背景模擬', simulate)}>{simulationKey.current ? '重試確認模擬' : '模擬目前編譯'}</button>
        {!runs.length && <p>尚無模擬紀錄。先編譯目前 Maker 草稿。</p>}
        {runs.map(run => <article key={run.id} className={styles.simulationCard}>
          <h4>v{run.revision} · {simulationState(run.state)}{!run.current || stale ? ' · 舊版' : ''}</h4>
          <p>{evidenceLabel(run.mode)}{run.mode ? ` · ${run.caseCount - run.skippedCaseCount} 個已執行案例／共 ${run.caseCount} 個` : ''}</p>
          {run.mode && <p>{run.passed && run.coverageComplete ? '此結果的案例皆通過；仍需需求、政策與錢包檢查。' : run.passed ? '仍有未執行案例，不能當作完整通過。' : '有案例未通過，可回到對話調整參數後重試。'}</p>}
          {!!run.issues.length && <ul>{run.issues.map(i => <li key={i.name}>{i.name}：{i.guidance}</li>)}</ul>}
          {run.errorCode && <p>狀態原因：{run.errorCode}</p>}
          <div className={styles.actions}><button disabled={!!busy} onClick={() => void act('讀取案例', () => show(run))}>查看 v{run.revision} 案例</button>
            {active(run) && <button disabled={!!busy} onClick={() => void act('取消背景模擬', async () => {
              if (!cancelKeys.current.has(run.id)) cancelKeys.current.set(run.id, crypto.randomUUID());
              await api.cancelSimulation(run.id, cancelKeys.current.get(run.id)!); if (live.current) await load();
            })}>取消 v{run.revision} 模擬</button>}</div>
        </article>)}
        {detail && <div className={styles.caseDetails}><h4>案例詳情 · v{detail.revision}</h4><p>{simulationState(detail.state)} · {detail.current && !stale ? '目前版本' : '歷史版本'} · {evidenceLabel(detail.report?.mode ?? null)}</p>
          {detail.report ? <ul>{detail.report.cases.map(c => <li key={c.name}><span>{c.passed === null ? '未執行' : c.passed ? '通過' : '未通過'}</span> {c.name}{c.error ? ` · ${c.error}` : ''}</li>)}</ul> : <p>此工作尚無完整結果。</p>}
          <button onClick={() => setDetail(null)}>收起案例</button></div>}
      </section>
      <p className={styles.notice}>下一步仍須逐項確認需求、設定 Maker 私密限制及事件管理同意，再審閱 approve／ship。這些步驟尚未接通，準備結果不會自行啟用 LP。</p>
    </div>
  </BuilderDialog>;
}
