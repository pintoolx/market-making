'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';
import { digestJson, sepoliaStandingProfile } from '@pintool/strategy-builder';
import { BuilderError, type BuilderClient, type Draft, type TransactionPlan, type WalletExecution } from './client';
import { verifyTransactionPlan } from './preparation';
import styles from './builder.module.css';

const unresolved = (e: WalletExecution) => ['awaiting-wallet', 'pending', 'unverified'].includes(e.state);
const labels: Record<WalletExecution['state'], string> = { 'awaiting-wallet': 'Awaiting wallet signature', pending: 'Awaiting chain confirmation',
  unverified: 'Receipt needs verification', confirmed: 'Confirmed onchain', reverted: 'Transaction reverted', replaced: 'Replaced by a different transaction', rejected: 'Wallet request cancelled' };
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-8)}`;
const rejected = (e: unknown): boolean => !!e && typeof e === 'object' && (('code' in e && e.code === 4001) || ('cause' in e && rejected(e.cause)));

/** Every send is an explicit user click on independently checked calldata. */
export default function WalletTransactions({ api, draft, wallet, refreshKey }: { api: BuilderClient; draft: Draft;
  wallet?: () => Promise<WalletClient>; refreshKey: string }) {
  const [data, setData] = useState<Awaited<ReturnType<BuilderClient['walletTransactions']>> | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [recoveryHash, setRecoveryHash] = useState('');
  const working = useRef(false), alive = useRef(true);
  const load = useCallback(async () => { const result = await api.walletTransactions(draft.id); if (alive.current) setData(result); }, [api, draft.id]);
  useEffect(() => { alive.current = true; void load().catch(() => setError('Wallet history could not be loaded.'));
    return () => { alive.current = false; }; }, [load, refreshKey]);
  const pending = data?.executions.some(e => e.state === 'pending' || e.state === 'unverified');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (working.current) return;
      working.current = true;
      void (async () => {
        try {
          for (const e of data?.executions.filter(e => e.state === 'pending' || e.state === 'unverified').slice(0, 3) ?? []) await api.reconcileWalletTransaction(e.id);
          await load();
        } catch { /* Keep the pending state and manual recovery available. */ }
        finally { working.current = false; }
      })();
    }, 3000);
    return () => clearInterval(timer);
  }, [pending, load, api, data]);
  const key = (id: string) => `pintool:builder:wallet:${draft.owner}:${id}`;
  async function act(label: string, work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(label); setError('');
    try { await work(); await load(); }
    catch (e) {
      if (alive.current) setError(e instanceof BuilderError ? e.message : e instanceof Error ? e.message : 'Wallet operation failed. Its history is retained.');
      // Rejection or a lost wallet response may still have changed the journal.
      // Refresh it even when the user-facing operation returned an error.
      await load().catch(() => {});
    }
    finally { working.current = false; if (alive.current) setBusy(''); }
  }
  async function recover(e: WalletExecution, supplied?: string) {
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(key(e.id)); } catch { /* Durable server record remains available. */ }
    const hash = supplied || remembered || e.transactionHash;
    if (hash && !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Enter a valid transaction hash.');
    const result = await api.reconcileWalletTransaction(e.id, hash as `0x${string}` | undefined);
    if (!unresolved(result.execution)) try { localStorage.removeItem(key(e.id)); } catch { /* Public recovery hint only. */ }
  }
  async function send(plan: TransactionPlan, step: number) {
    if (!wallet) throw new Error('Connect this Maker wallet before signing.');
    const artifact = await api.compilation(plan.artifactId);
    verifyTransactionPlan({ plan, digest: digestJson(plan) }, draft, artifact, plan.kind);
    const client = await wallet();
    if (!client.account || client.account.address.toLowerCase() !== draft.maker || await client.getChainId() !== sepolia.id) throw new Error('Select the Maker wallet on Ethereum Sepolia.');
    const { execution } = await api.prepareWalletTransaction(plan.id, step, crypto.randomUUID());
    await load();
    const tx = plan.transactions[step], request = execution.request;
    if (execution.owner !== draft.owner || execution.planId !== plan.id || execution.step !== step || execution.state !== 'awaiting-wallet' ||
      request.chainId !== sepolia.id || request.from !== draft.maker || request.to !== tx.to || request.data !== tx.data || request.value !== '0x0' ||
      !/^\d+$/.test(request.nonce) || BigInt(request.nonce) > BigInt(Number.MAX_SAFE_INTEGER) || !/^[1-9]\d*$/.test(request.gas) ||
      !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('The wallet request no longer matches the reviewed plan.');
    let hash: `0x${string}`;
    try { hash = await client.sendTransaction({ account: client.account, chain: sepolia, to: request.to, data: request.data, value: 0n, nonce: Number(request.nonce), gas: BigInt(request.gas) }); }
    catch (e) { if (rejected(e)) await api.rejectWalletTransaction(execution.id); throw e; }
    try { localStorage.setItem(key(execution.id), hash); } catch { /* Maker + nonce also supports server recovery. */ }
    await recover(execution, hash);
  }
  return <section aria-label="Wallet transaction execution"><h3>7. Sign and track wallet transactions</h3>
    <p>Each button opens your wallet for one transaction. Registration, report acceptance and successful trading have separate evidence.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}{busy && <p role="status">{busy}</p>}
    {!data?.enabled && <p>Wallet execution is not enabled on this service. Prepared plans remain available for review.</p>}
    <button disabled={!!busy} onClick={() => void act('Refreshing wallet history', load)}>Refresh wallet history</button>
    {data?.executions.filter(unresolved).map(e => <div key={e.id} className={styles.planResult}>
      <strong>{labels[e.state]} · nonce {e.nonce}</strong><p>Gas limit: {e.request.gas}. Your wallet displays the current network fee.</p><p>A pending request blocks another Builder transaction from this wallet.</p>
      <button disabled={!!busy} onClick={() => void act('Checking canonical transaction', () => recover(e))}>Check transaction</button>
      {e.state === 'awaiting-wallet' && <button disabled={!!busy} onClick={() => void act('Closing unsigned request', async () => { await api.rejectWalletTransaction(e.id); })}>I closed or rejected the wallet request</button>}
      <label>Transaction hash for recovery<input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…" /></label>
      <button disabled={!!busy || !recoveryHash} onClick={() => void act('Verifying supplied transaction', () => recover(e, recoveryHash))}>Verify recovery hash</button>
    </div>)}
    {data?.plans.map(({ plan }) => <article key={plan.id} className={styles.planResult}>
      <strong>{plan.kind} · v{plan.revision}</strong><p>Strategy {short(plan.strategyHash)}</p>
      {plan.kind === 'allowance-revoke' && <p className={styles.notice}>This removes Aqua spending permission for these tokens across all strategies using this wallet.</p>}
      {plan.kind === 'guard-unrevoke' && <p>Clearing revocation does not reactivate trading. Enable event management for a fresh report.</p>}
      <ol>{plan.transactions.map((tx, step) => {
        const executions = data.executions.filter(e => e.planId === plan.id && e.step === step), latest = executions[0];
        const blocked = data.executions.some(e => unresolved(e) && (e.planId !== plan.id || e.step !== step || e.state !== 'awaiting-wallet'));
        return <li key={step}><p>{tx.description}</p><p>To {tx.to} · Value 0 ETH · Ethereum Sepolia</p>
          {tx.amountAtomic && <><p>Allowance: {formatUnits(BigInt(tx.amountAtomic), sepoliaStandingProfile.tokens.find(t => t.address === tx.token)!.decimals)} · Spender {tx.spender}</p>
            <p>This sets the shared Aqua allowance for this token and can affect other strategies using this wallet.</p></>}
          <details><summary>Review calldata</summary><pre>{tx.data}</pre></details>
          {latest && <p>{labels[latest.state]}{latest.transactionHash && <> · <a href={`https://sepolia.etherscan.io/tx/${latest.transactionHash}`} target="_blank" rel="noreferrer">View transaction</a></>}</p>}
          <button disabled={!!busy || !wallet || !data.enabled || blocked || latest?.state === 'confirmed' || (plan.kind === 'registration' && plan.revision !== draft.revision)}
            onClick={() => void act('Confirm this transaction in your wallet', () => send(plan, step))}>{latest?.state === 'awaiting-wallet' ? 'Retry wallet signature' : 'Review and sign transaction'}</button>
        </li>;
      })}</ol>
    </article>)}
  </section>;
}
