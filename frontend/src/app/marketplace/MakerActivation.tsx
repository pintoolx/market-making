'use client';

import { useEffect, useRef, useState } from 'react';
import { createPublicClient, erc20Abi, formatUnits, http, keccak256, parseUnits, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { aquaActivationAbi } from '../../../../shared/aqua-activation.mjs';
import deployment from '../../../../contracts/aqua-executor/deployments/11155111.json';
import type { Account } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { request } from './mandateClient';
import type { Listing } from './publishedStore';
import type { PublicRelease } from './ClmmPublisher';
import aqua from './aqua.module.css';

type Activation = {
  id: string; maker: Hex; name: string; chainId: number; aqua: Hex; router: Hex; tokens: [Hex, Hex]; amounts: [string, string];
  release: { id: string; version: number; digest: string }; strategy: Hex; strategyHash: Hex;
  range: { min: string; max: string }; reference: { price: string; observedAt: number }; programDeadline: number;
  transactionHash: Hex | null; funding?: { token: string; balance: string; allowance: string; required: string }[];
};
type Pending = { kind: 'approval' | 'ship'; hash: Hex };
const client = createPublicClient({ chain: sepolia, transport: http(process.env.NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', { timeout: 15000, retryCount: 1 }) });
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export default function MakerActivation({ listing, maker, account, onReady }: { listing: Listing; maker: string; account: Account; onReady: () => Promise<void> }) {
  const [weth, setWeth] = useState('');
  const [usdc, setUsdc] = useState('');
  const [plan, setPlan] = useState<Activation | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const current = useRef<{ id: string; amounts?: [string, string]; pending?: Pending } | null>(null);
  const key = `pintool:activation:${maker.toLowerCase()}:${listing.id}`;

  const remember = () => { try { localStorage.setItem(key, JSON.stringify(current.current)); } catch { /* In-memory receipt remains available. */ } };
  const validate = async (value: Activation) => {
    const release = await request<PublicRelease>(`/v1/provider-strategies/${listing.releaseId}/versions/${listing.version}`);
    if (value.maker.toLowerCase() !== maker.toLowerCase() || value.chainId !== sepolia.id
      || value.aqua.toLowerCase() !== deployment.aqua || value.router.toLowerCase() !== deployment.router
      || value.tokens[0]?.toLowerCase() !== deployment.tokens.WETH || value.tokens[1]?.toLowerCase() !== deployment.tokens.USDC
      || value.release.id !== listing.releaseId || value.release.version !== listing.version || value.release.digest !== release.digest
      || release.state !== 'published' || keccak256(value.strategy) !== value.strategyHash
      || value.amounts.some((a, i) => a !== current.current?.amounts?.[i])) throw new Error('The activation does not match the selected strategy, wallet and amounts.');
    return value;
  };
  const load = async (id: string) => {
    const value = await validate(await request<Activation>(`/v1/activations/${id}`));
    setPlan(value);
    setReady(!!value.transactionHash);
    return value;
  };
  useEffect(() => {
    let alive = true;
    const restore = async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.id && Array.isArray(saved.amounts) && saved.amounts.length === 2) {
          current.current = saved;
          setPending(saved.pending ?? null);
          const value = await validate(await request<Activation>(`/v1/activations/${saved.id}`));
          if (!alive) return;
          setWeth(formatUnits(BigInt(value.amounts[0]), 18)); setUsdc(formatUnits(BigInt(value.amounts[1]), 6));
          setPlan(value); setPending(saved.pending ?? null); setReady(!!value.transactionHash);
        }
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : 'Activation could not be restored.'); }
      finally { if (alive) setLoaded(true); }
    };
    void restore();
    return () => { alive = false; };
    // Component is keyed by Maker and selected publication; never reuse an old wallet's plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setError(''); setBusy(label);
    try { await fn(); }
    catch (reason) { setError(reason instanceof Error ? ('shortMessage' in reason ? String(reason.shortMessage) : reason.message) : 'Activation failed. Your completed steps are preserved.'); }
    finally { setBusy(''); }
  };
  const prepare = () => act('Preparing strategy…', async () => {
    const atomic = (value: string, decimals: number) => {
      if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(value) || parseUnits(value, decimals) <= BigInt(0)) throw new Error('Enter positive amounts within token precision.');
      return parseUnits(value, decimals).toString();
    };
    const amounts: [string, string] = [atomic(weth, 18), atomic(usdc, 6)];
    if (!current.current || JSON.stringify(current.current.amounts) !== JSON.stringify(amounts)) current.current = { id: crypto.randomUUID(), amounts };
    const value = await request<Activation>('/v1/activations', { method: 'POST', body: JSON.stringify({ id: current.current.id, maker, releaseId: listing.releaseId, version: listing.version, amounts }) });
    await validate(value); remember(); await load(value.id);
  });
  const wait = async (next: Pending, value: Activation) => {
    const receipt = await client.waitForTransactionReceipt({ hash: next.hash, confirmations: 1, timeout: 120000 });
    if (receipt.status !== 'success') {
      current.current!.pending = undefined; setPending(null); remember();
      throw new Error('The wallet transaction reverted. Review your balances and try again.');
    }
    if (next.kind === 'ship') await request(`/v1/activations/${value.id}/confirm`, { method: 'POST', body: JSON.stringify({ transactionHash: next.hash }) });
    current.current!.pending = undefined; setPending(null); remember(); await load(value.id);
  };
  const sign = (kind: 'ship' | 'approval', index = 0) => act(kind === 'ship' ? 'Waiting for activation signature…' : 'Waiting for token approval…', async () => {
    if (!plan || !account.evmWallet) throw new Error('Connect your Maker wallet.');
    if (pending) { await wait(pending, plan); return; }
    const value = await load(plan.id);
    if (value.transactionHash) return;
    if (value.programDeadline <= Math.floor(Date.now() / 1000)) throw new Error('This program has expired. Prepare a new activation.');
    const wallet = await account.evmWallet(maker);
    if (!wallet.account || wallet.account.address.toLowerCase() !== maker.toLowerCase() || await wallet.getChainId() !== sepolia.id) throw new Error('Select the Maker wallet on Ethereum Sepolia.');
    let hash: Hex;
    if (kind === 'approval') {
      const { request: tx } = await client.simulateContract({ account: wallet.account, address: value.tokens[index], abi: erc20Abi, functionName: 'approve', args: [value.aqua, BigInt(value.amounts[index])] });
      hash = await wallet.writeContract({ ...tx, chain: sepolia });
    } else {
      const { request: tx } = await client.simulateContract({ account: wallet.account, address: value.aqua, abi: aquaActivationAbi, functionName: 'ship', args: [value.router, value.strategy, value.tokens, value.amounts.map(BigInt)] });
      hash = await wallet.writeContract({ ...tx, chain: sepolia });
    }
    const next = { kind, hash }; current.current!.pending = next; setPending(next); remember();
    setBusy('Confirming wallet transaction…'); await wait(next, value);
  });

  const funded = plan?.funding?.every(f => BigInt(f.balance) >= BigInt(f.required)) ?? false;
  const approved = plan?.funding?.every(f => BigInt(f.allowance) >= BigInt(f.required)) ?? false;
  return <div className={aqua.decisionGrid}>
    <div className={aqua.panel}>
      <h2>Enable {listing.name}</h2>
      <p>Version {listing.version} · WETH / USDC · Ethereum Sepolia</p>
      {!plan && pending ? <Primary disabled={!!busy} onClick={() => void act('Restoring activation…', async () => { await load(current.current!.id); })}>Restore pending transaction</Primary> : !plan ? <form onSubmit={e => { e.preventDefault(); void prepare(); }}>
        <fieldset disabled={!loaded || !!busy}>
          <legend>Liquidity allocation</legend>
          <label>WETH amount<FormInput required inputMode="decimal" value={weth} onChange={e => setWeth(e.target.value)} /></label>
          <label>USDC amount<FormInput required inputMode="decimal" value={usdc} onChange={e => setUsdc(e.target.value)} /></label>
        </fieldset>
        <Primary disabled={!loaded || !!busy} type="submit">{busy || 'Review activation'}</Primary>
      </form> : <>
        <dl className={aqua.intentRows}>
          <div><dt>Allocation</dt><dd>{formatUnits(BigInt(plan.amounts[0]), 18)} WETH + {formatUnits(BigInt(plan.amounts[1]), 6)} USDC</dd></div>
          <div><dt>Price range (USDC per WETH)</dt><dd>{Number(plan.range.min).toFixed(2)}–{Number(plan.range.max).toFixed(2)}</dd></div>
          <div><dt>Reference price</dt><dd>{plan.reference.price} USDC</dd></div>
          <div><dt>Program ends</dt><dd>{new Date(plan.programDeadline * 1000).toISOString().slice(0, 10)} UTC</dd></div>
          <div><dt>Strategy hash</dt><dd><code title={plan.strategyHash}>{shortHash(plan.strategyHash)}</code></dd></div>
        </dl>
        {plan.funding?.map((f, i) => <p key={f.token}>{i === 0 ? 'WETH' : 'USDC'} balance: {formatUnits(BigInt(f.balance), i === 0 ? 18 : 6)} · {BigInt(f.allowance) >= BigInt(f.required) ? 'Aqua approval ready' : 'Approval required'}</p>)}
        <div className={aqua.actionRow}>
          {ready ? <Primary disabled={!!busy} onClick={() => void act('Loading strategy…', onReady)}>Set private limits</Primary>
            : pending ? <Primary disabled={!!busy} onClick={() => void act('Confirming transaction…', () => wait(pending, plan))}>Retry confirmation</Primary>
              : <>
                {plan.funding?.map((f, i) => BigInt(f.allowance) < BigInt(f.required) && <Secondary key={f.token} disabled={!!busy} onClick={() => void sign('approval', i)}>Approve {i === 0 ? 'WETH' : 'USDC'} in wallet</Secondary>)}
                <Primary disabled={!!busy || !funded || !approved} onClick={() => void sign('ship')}>Sign and enable strategy</Primary>
              </>}
          <Secondary disabled={!!busy} onClick={() => void act('Refreshing balances…', async () => { await load(plan.id); })}>Refresh balances</Secondary>
          {!ready && !pending && <Secondary disabled={!!busy} onClick={() => { current.current = null; localStorage.removeItem(key); setPlan(null); setError(''); }}>Edit allocation</Secondary>}
        </div>
        {!ready && !funded && <p>Add sufficient WETH and USDC to your Maker wallet, then refresh balances.</p>}
        {(pending?.hash || plan.transactionHash) && <a href={`https://sepolia.etherscan.io/tx/${pending?.hash || plan.transactionHash}`} target="_blank" rel="noreferrer">View wallet transaction ↗</a>}
        {ready && <p role="status">Aqua registration confirmed. Set your private limits next; trading still requires Guard authorization.</p>}
      </>}
      {busy && <p role="status">{busy}</p>}
      {error && <p role="alert" className={aqua.fieldError}>{error}</p>}
    </div>
    <aside className={aqua.explanation}>
      <h2>Your wallet provides the liquidity</h2>
      <p>Aqua registers the amounts this strategy can use. Your tokens stay in your wallet until a trade settles.</p>
      <p>Token approval and strategy registration are separate wallet transactions. Review and sign each request in your wallet.</p>
      <p>The Provider&apos;s published version fixes this price range. Your private mandate can narrow execution, and Guard must authorize the strategy before it trades.</p>
    </aside>
  </div>;
}
