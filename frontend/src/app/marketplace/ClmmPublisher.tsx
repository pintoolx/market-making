'use client';

import { useEffect, useRef, useState } from 'react';
import { parseUnits, formatUnits, keccak256, toHex } from 'viem';
import { parseRelease, percentToBps, providerPolicy, publicationMessage, type LpRelease } from '../../../../shared/lp-release.mjs';
import { useAccount } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { request } from './mandateClient';
import { CONFIDENTIAL_WORKFLOW_PUBLIC_KEY, sealProviderStrategy } from './confidentialEnvelope';
import aqua from './aqua.module.css';
import EnsWorkspace from '../ens/EnsWorkspace';

export type PublicRelease = LpRelease & { digest: string; executionStatus: string };
export default function ClmmPublisher({ onBack }: { onBack: () => void }) {
  const account = useAccount();
  const [latest, setLatest] = useState<PublicRelease | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('Adaptive range');
  const [summary, setSummary] = useState('Quotes WETH / USDC within a defined range while market volatility remains within the strategy\'s private limit.');
  const [below, setBelow] = useState('5');
  const [above, setAbove] = useState('5');
  const [fill0, setFill0] = useState('0.0004');
  const [fill1, setFill1] = useState('1');
  const [inventory0, setInventory0] = useState('1');
  const [inventory1, setInventory1] = useState('1000');
  const [ttl, setTtl] = useState('300');
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'signing' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const pending = useRef<{ key: string; body: string; formKey: string; state: 'published' | 'withdrawn' } | null>(null);
  const provider = account.address?.toLowerCase();
  const publicKey = CONFIDENTIAL_WORKFLOW_PUBLIC_KEY;
  const formKey = JSON.stringify([provider, name, summary, below, above, fill0, fill1, inventory0, inventory1, ttl, threshold]);
  const canRetrySave = pending.current?.state === 'published' && pending.current.formKey === formKey;

  useEffect(() => {
    let alive = true;
    setLoaded(false); setLatest(null); setThreshold(''); setSaved(false); pending.current = null;
    if (!provider) return;
    request<{ strategies: PublicRelease[] }>('/v1/provider-strategies').then(result => {
      if (!alive) return;
      const current = result.strategies.find(item => item.provider === provider);
      if (current) {
        const e = current.execution;
        setLatest(current); setName(current.name); setSummary(current.summary);
        setBelow(String(e.rangeBelowBps / 100)); setAbove(String(e.rangeAboveBps / 100));
        setFill0(formatUnits(BigInt(e.maxAmount0PerSwap), 18)); setFill1(formatUnits(BigInt(e.maxAmount1PerSwap), 6));
        setInventory0(formatUnits(BigInt(e.maxPostBalance0), 18)); setInventory1(formatUnits(BigInt(e.maxPostBalance1), 6)); setTtl(String(e.ttlSec));
      }
      setLoaded(true); setError('');
    }).catch(() => { if (alive) setError('The publication service could not be loaded. Your inputs remain here; return and retry when it is available.'); });
    return () => { alive = false; };
  }, [provider]);

  const publish = async (state: 'published' | 'withdrawn') => {
    setError(''); setSaved(false);
    let stage: 'preparing' | 'signing' | 'saving' = 'preparing';
    try {
      if (!provider || !account.signMessage || !loaded) throw new Error('Connect the wallet that will publish this strategy and reload the current version.');
      if (!publicKey) throw new Error('Secure publication is temporarily unavailable.');
      // viem parseUnits rounds excess precision, so reject it before conversion.
      const atomic = (value: string, decimals: number) => {
        if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(value)) throw new Error('Token amounts exceed supported precision.');
        return parseUnits(value, decimals).toString();
      };
      const release = parseRelease({ schema: 'pintool-lp-release-v1', id: `${provider.slice(2)}-clmm`, version: (latest?.version ?? 0) + 1,
        provider, name: name.trim(), summary: summary.trim(), state, execution: {
          curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0,
          rangeBelowBps: percentToBps(below), rangeAboveBps: percentToBps(above),
          maxAmount0PerSwap: atomic(fill0, 18), maxAmount1PerSwap: atomic(fill1, 6),
          maxPostBalance0: atomic(inventory0, 18), maxPostBalance1: atomic(inventory1, 6), ttlSec: Number(ttl),
        } });
      if (state === 'published' && threshold === '') throw new Error('Enter the private volatility limit for this version. Previous limits are never replaced with defaults.');
      setBusy(true);
      const key = JSON.stringify({ release, threshold: state === 'withdrawn' ? '' : threshold });
      if (pending.current?.key !== key) {
        const policy = providerPolicy(release, state === 'withdrawn' ? 0 : percentToBps(threshold));
        const envelope = sealProviderStrategy(policy, publicKey, provider);
        stage = 'signing'; setPhase('signing');
        const signature = await account.signMessage(publicationMessage(release, envelope));
        pending.current = { key, body: JSON.stringify({ release, envelope, signature }), formKey, state };
      }
      stage = 'saving'; setPhase('saving');
      const result = await request<PublicRelease>('/v1/provider-strategies', { method: 'POST', body: pending.current.body });
      const signed = JSON.parse(pending.current.body);
      if (result.id !== release.id || result.version !== release.version || result.digest !== keccak256(toHex(publicationMessage(signed.release, signed.envelope)))) throw new Error('Publication receipt did not match this version.');
      setLatest(result); setSaved(true); setThreshold(''); pending.current = null;
      window.dispatchEvent(new Event('pintool:published-changed'));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Publication failed.';
      const networkFailure = reason instanceof TypeError && /fetch|network|load failed/i.test(message);
      if (stage === 'saving' && networkFailure) {
        setError('The publication service could not be reached. Keep this tab open and retry saving with the same inputs; your wallet signature is preserved.');
      } else if (stage === 'signing') {
        setError(`Wallet signing did not complete. Your inputs are preserved. ${message}`);
      } else setError(message);
    } finally { setBusy(false); setPhase(null); }
  };

  return <section className={aqua.flow}>
    <button className={aqua.backLink} onClick={onBack}>← All templates</button>
    <h1>{latest ? 'Edit adaptive range strategy' : 'Create an adaptive range strategy'}</h1>
    <p className={aqua.muted}>WETH / USDC · Ethereum Sepolia · 1inch Aqua</p>
    {latest?.state === 'withdrawn' && <p>This strategy is closed to new makers.</p>}
    <form className={aqua.panel} onSubmit={event => { event.preventDefault(); void publish('published'); }}>
      <fieldset disabled={busy}>
        <legend>Public strategy details</legend>
        <label>Strategy name<FormInput required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Description<textarea required maxLength={600} value={summary} onChange={e => setSummary(e.target.value)} /></label>
        <div className={aqua.structuredFields}>
          {[
            ['Range below reference price (%)', below, setBelow], ['Range above reference price (%)', above, setAbove],
            ['Maximum WETH per swap', fill0, setFill0], ['Maximum USDC per swap', fill1, setFill1],
            ['Maximum WETH inventory', inventory0, setInventory0], ['Maximum USDC inventory', inventory1, setInventory1],
          ].map(([label, value, setter]) => <label key={label as string}>{label as string}<FormInput required inputMode="decimal" value={value as string} onChange={e => (setter as (v: string) => void)(e.target.value)} /></label>)}
        </div>
      </fieldset>
      <fieldset disabled={busy} className={aqua.privateField}>
        <legend>Confidential execution rule</legend>
        <p>Allow swaps only when 30-minute market volatility is at or below this limit.</p>
        <label>Maximum volatility (%)<FormInput inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
        <p className={aqua.hint}>Encrypted before submission and never published.</p>
      </fieldset>
      {error && <p role="alert" className={aqua.fieldError}>{error}</p>}
      {saved && <p role="status">{latest?.state === 'withdrawn' ? 'Closed to new makers. Existing liquidity remains active.' : 'Strategy published. Makers can now add liquidity.'}</p>}
      <div className={aqua.actionRow}>
        {!account.authenticated ? <Primary type="button" onClick={account.login}>Connect publishing wallet</Primary> : <Primary type="submit" disabled={busy || !loaded || !publicKey}>{busy ? phase === 'signing' ? 'Waiting for wallet…' : 'Saving…' : canRetrySave ? 'Retry saving' : latest ? 'Sign and publish update' : 'Sign and publish strategy'}</Primary>}
        {latest?.state === 'published' && <Secondary type="button" disabled={busy || !loaded} onClick={() => void publish('withdrawn')}>Close to new makers</Secondary>}
      </div>
      {!publicKey && <p className={aqua.muted}>Secure publication is temporarily unavailable.</p>}
    </form>
    {latest?.state === 'published' && <EnsWorkspace key={provider} account={account} release={latest} />}
  </section>;
}
