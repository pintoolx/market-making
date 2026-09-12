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

export type PublicRelease = LpRelease & { digest: string; executionStatus: string };
export default function ClmmPublisher({ onBack }: { onBack: () => void }) {
  const account = useAccount();
  const [latest, setLatest] = useState<PublicRelease | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('Adaptive range');
  const [summary, setSummary] = useState('A single WETH / USDC price range, authorized when 30-minute volatility is within my limit.');
  const [below, setBelow] = useState('5');
  const [above, setAbove] = useState('5');
  const [fill0, setFill0] = useState('0.0004');
  const [fill1, setFill1] = useState('1');
  const [inventory0, setInventory0] = useState('1');
  const [inventory1, setInventory1] = useState('1000');
  const [ttl, setTtl] = useState('300');
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const pending = useRef<{ key: string; body: string } | null>(null);
  const provider = account.address?.toLowerCase();
  const publicKey = CONFIDENTIAL_WORKFLOW_PUBLIC_KEY;

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
    try {
      if (!provider || !account.signMessage || !loaded) throw new Error('Connect your Provider wallet and load the current version first.');
      if (!publicKey) throw new Error('The confidential workflow public key is not configured.');
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
        const signature = await account.signMessage(publicationMessage(release, envelope));
        pending.current = { key, body: JSON.stringify({ release, envelope, signature }) };
      }
      const result = await request<PublicRelease>('/v1/provider-strategies', { method: 'POST', body: pending.current.body });
      const signed = JSON.parse(pending.current.body);
      if (result.id !== release.id || result.version !== release.version || result.digest !== keccak256(toHex(publicationMessage(signed.release, signed.envelope)))) throw new Error('Publication receipt did not match this version.');
      setLatest(result); setSaved(true); setThreshold(''); pending.current = null;
      window.dispatchEvent(new Event('pintool:published-changed'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Publication failed. Your inputs are preserved.'); }
    finally { setBusy(false); }
  };

  return <section className={aqua.flow}>
    <button className={aqua.backLink} onClick={onBack}>← All templates</button>
    <h1>Publish a CLMM version</h1>
    <p className={aqua.muted}>Ethereum Sepolia · WETH / USDC · one price range · zero swap fee. Revenue sharing is not enabled.</p>
    {latest && <p>Saved version {latest.version} · {latest.state}. Public parameters below are restored from that version.</p>}
    <form className={aqua.panel} onSubmit={event => { event.preventDefault(); void publish('published'); }}>
      <fieldset disabled={busy}>
        <legend>Public execution envelope</legend>
        <label>Name<FormInput required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Description<textarea required maxLength={600} value={summary} onChange={e => setSummary(e.target.value)} /></label>
        <div className={aqua.structuredFields}>
          {[
            ['Range below reference (%)', below, setBelow], ['Range above reference (%)', above, setAbove],
            ['Maximum WETH per fill', fill0, setFill0], ['Maximum USDC per fill', fill1, setFill1],
            ['Maximum WETH inventory', inventory0, setInventory0], ['Maximum USDC inventory', inventory1, setInventory1],
            ['Report lifetime (seconds, at most 600)', ttl, setTtl],
          ].map(([label, value, setter]) => <label key={label as string}>{label as string}<FormInput required inputMode="decimal" value={value as string} onChange={e => (setter as (v: string) => void)(e.target.value)} /></label>)}
        </div>
      </fieldset>
      <fieldset disabled={busy} className={aqua.privateField}>
        <legend>Private activation policy</legend>
        <p>Allow both Maker directions when 30-minute realized volatility is at or below this limit. Kraken one-minute returns use the fixed RSS formula. Each observation is evaluated independently; hysteresis and automatic range renewal are not enabled.</p>
        <label>Volatility limit (%)<FormInput inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
        <p className={aqua.hint}>The limit is encrypted in this browser before submission and cleared after success. Unsubmitted inputs stay in memory only and are lost on leaving this editor. Re-enter the limit when creating a new version; the service cannot return its plaintext. The current runtime is a local CRE simulator, whose operator can access decrypted inputs; TEE confidentiality has not been verified.</p>
      </fieldset>
      {error && <p role="alert" className={aqua.fieldError}>{error}</p>}
      {saved && <p role="status">Version {latest?.version} {latest?.state === 'withdrawn' ? 'withdrawn from new provisioning. Existing onchain authorizations must expire or be docked.' : 'saved. The Maker-specific program must be provisioned, shipped and authorized before it can quote.'}</p>}
      <div className={aqua.actionRow}>
        {!account.authenticated ? <Primary type="button" onClick={account.login}>Connect Provider wallet</Primary> : <Primary type="submit" disabled={busy || !loaded || !publicKey}>{busy ? 'Saving…' : `Sign and publish version ${(latest?.version ?? 0) + 1}`}</Primary>}
        {latest?.state === 'published' && <Secondary type="button" disabled={busy || !loaded} onClick={() => void publish('withdrawn')}>Withdraw listing</Secondary>}
      </div>
      {!publicKey && <p className={aqua.muted}>Publication is waiting for a configured workflow encryption key.</p>}
    </form>
  </section>;
}
