'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { type Address } from 'viem';
import type { Account } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import { request } from '../marketplace/mandateClient';
import type { PublicRelease } from '../marketplace/ClmmPublisher';
import { ensTransactions, type EnsProgress } from '../../../../shared/ens/transactions.mjs';
import { manifestMessage, RELEASE_KEY } from '../../../../shared/ens/schema.mjs';
import { ensClient, ensError, getEnsConfig, getEnsStatus, resolveEnsStrategy, verifyManifest, type EnsStatus, type PublicManifest } from './ensClient';
import aqua from '../marketplace/aqua.module.css';
import styles from './ens.module.css';

export default function EnsWorkspace({ account, release }: { account: Account; release?: PublicRelease | null }) {
  const [root, setRoot] = useState('');
  const [status, setStatus] = useState<EnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [providerLabel, setProviderLabel] = useState('');
  const [strategyLabel, setStrategyLabel] = useState('eth-usdc');
  const [delegateAddress, setDelegateAddress] = useState('');
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [latest, setLatest] = useState<PublicRelease | null>(release ?? null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<EnsProgress | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [approved, setApproved] = useState<PublicManifest | null>(null);
  const epoch = useRef(0);
  const name = status?.provider ? `${strategyLabel}.${status.provider.name}` : '';
  const refresh = useCallback(async () => {
    const generation = epoch.current;
    setLoading(true); setStatusError('');
    try {
      const config = await getEnsConfig();
      if (generation !== epoch.current) return;
      setRoot(config.rootName);
      const next = await getEnsStatus(account.address);
      if (generation === epoch.current) setStatus(next);
    } catch (reason) {
      if (generation === epoch.current) { setStatus(null); setStatusError(reason instanceof Error ? reason.message : 'ENS could not be loaded.'); }
    } finally { if (generation === epoch.current) setLoading(false); }
  }, [account.address]);
  useEffect(() => {
    const activeEpoch = epoch;
    activeEpoch.current++; setApproved(null); setError(''); setSuccess(''); setCurrentVersion(null); setStatus(null);
    void refresh();
    return () => { activeEpoch.current++; };
  }, [refresh]);
  useEffect(() => { if (release !== undefined) setLatest(release); }, [release]);
  useEffect(() => {
    if (release !== undefined || !account.address) return;
    let alive = true;
    setLatest(null);
    request<{ strategies: PublicRelease[] }>('/v1/provider-strategies').then(data => {
      if (alive) setLatest(data.strategies.find(item => item.provider === account.address?.toLowerCase()) ?? null);
    }).catch(() => { if (alive) setError('Published versions could not be loaded. Open the strategy editor to retry.'); });
    return () => { alive = false; };
  }, [account.address, release]);
  useEffect(() => { setApproved(null); setCurrentVersion(null); setSuccess(''); }, [name, latest?.digest]);
  const act = async (job: (tx: ReturnType<typeof ensTransactions>) => Promise<void>) => {
    if (busy) return;
    const generation = epoch.current;
    setBusy(true); setError(''); setSuccess(''); setProgress(null);
    try {
      if (!account.ensWallet) throw new Error('Connect an Ethereum wallet first.');
      const wallet = await account.ensWallet();
      if (generation !== epoch.current) throw new Error('Wallet changed. Start the action again.');
      const tx = ensTransactions(ensClient, wallet, p => { if (generation === epoch.current) setProgress(p); });
      await job(tx);
    } catch (reason) { if (generation === epoch.current) setError(ensError(reason)); }
    finally { setBusy(false); }
  };
  const approve = () => act(async tx => {
    if (!latest || latest.state !== 'published' || !account.signMessage) throw new Error('Publish a strategy version first.');
    const created = await tx.registerStrategy(root, strategyLabel);
    setProgress({ title: 'Review the public version approval in your wallet' });
    const signature = await account.signMessage(manifestMessage(created, root, latest, latest.digest));
    const saved = await request<PublicManifest>('/v1/ens/manifests', { method: 'POST', body: JSON.stringify({ name: created,
      releaseId: latest.id, version: latest.version, publicationDigest: latest.digest, signature }) });
    await verifyManifest(saved, root); setApproved(saved);
    setSuccess(`Version ${saved.pointer.version} approved. You or an authorized publisher can now update the ENS entry.`);
  });
  const publish = () => act(async tx => {
    if (!latest) throw new Error('Publish and approve a strategy version first.');
    const manifest = approved ?? await request<PublicManifest>(`/v1/ens/manifest?name=${encodeURIComponent(name)}&releaseId=${latest.id}&version=${latest.version}`);
    await verifyManifest(manifest, root);
    await tx.publishPointer(root, name, manifest.pointer);
    const confirmed = await resolveEnsStrategy(name);
    setCurrentVersion(confirmed.pointer.version); setSuccess(`Version ${confirmed.pointer.version} is discoverable through ${name}.`);
    window.dispatchEvent(new Event('pintool:published-changed'));
  });

  return <section className={`${aqua.panel} ${styles.workspace}`} aria-label="ENS strategy publishing" aria-busy={busy}>
    <div className={styles.heading}><div><span className={aqua.eyebrow}>ENSv2 · Ethereum Sepolia</span><h2>Your strategy names</h2></div><Secondary disabled={loading || busy} onClick={() => void refresh()}>Refresh ENS</Secondary></div>
    <p>Give your strategy a name that Makers can verify and share. Delegate version updates while keeping control of your Provider identity.</p>
    {loading && <p role="status" className={styles.skeleton}>Checking the platform namespace…</p>}
    {statusError && <div role="status" className={styles.notice}><p>{statusError}</p><p>ENS names are temporarily unavailable. Try Refresh ENS in a moment.</p></div>}
    {!account.authenticated && <Primary onClick={account.login}>Connect Provider wallet</Primary>}
    {status && account.authenticated && !status.provider && <form onSubmit={e => { e.preventDefault(); void act(async tx => {
      await tx.claimProvider(root, providerLabel); await refresh(); setSuccess('Your Provider namespace is ready.');
    }); }}>
      <fieldset disabled={busy}><legend>Claim your Provider name</legend>
        <label>Provider label<FormInput required autoComplete="off" spellCheck={false} minLength={3} maxLength={32} value={providerLabel} onChange={e => setProviderLabel(e.target.value)} placeholder="alice" /></label>
        <p className={aqua.hint}>{providerLabel || 'alice'}.{root} · one Provider name per wallet. Registration uses Sepolia ETH for gas.</p>
        <Primary type="submit">Claim Provider name</Primary>
      </fieldset>
    </form>}
    {status?.provider && <>
      <div className={styles.identity}><strong>{status.provider.name}</strong><span>Provider wallet {account.address}</span></div>
      <fieldset disabled={busy}>
        <legend>Publish a named strategy</legend>
        <label>Strategy label<FormInput value={strategyLabel} autoComplete="off" spellCheck={false} minLength={3} maxLength={32} onChange={e => setStrategyLabel(e.target.value)} /></label>
        <p className={styles.name}>{name}</p>
        <p>{latest?.state === 'published' ? `Saved publication: ${latest.name}, version ${latest.version}.` : 'Publish a strategy version in Provider Studio to connect it to this name.'}</p>
        <div className={aqua.actionRow}><Primary disabled={!latest || latest.state !== 'published'} onClick={approve}>Approve version for ENS</Primary><Secondary disabled={!latest || latest.state !== 'published'} onClick={publish}>Publish approved version</Secondary></div>
        {currentVersion && <p role="status">ENS currently points to version {currentVersion}.</p>}
        <p className={aqua.hint}>Approval creates the strategy name if needed and signs its public manifest. Publishing updates the name onchain. Existing Makers keep their selected version.</p>
      </fieldset>
      <form onSubmit={e => { e.preventDefault(); void act(async tx => { await tx.delegate(root, name, delegateAddress as Address, true); setSuccess('Publisher can update this strategy’s version record.'); }); }}>
        <fieldset disabled={busy}><legend>Delegate version updates</legend>
          <label>Publisher wallet<FormInput required value={delegateAddress} autoComplete="off" spellCheck={false} placeholder="0x…" onChange={e => setDelegateAddress(e.target.value)} /></label>
          <p className={aqua.hint}>This grants access to {RELEASE_KEY} on {name}. The publisher must use a version you have signed. It grants no Maker asset or Guard permissions.</p>
          <div className={aqua.actionRow}><Primary type="submit">Authorize publisher</Primary><Secondary type="button" onClick={() => void act(async tx => { await tx.delegate(root, name, delegateAddress as Address, false); setSuccess('Publisher access revoked and checked onchain.'); })}>Revoke publisher</Secondary></div>
        </fieldset>
      </form>
      <p><Link href={`/strategy?ens=${encodeURIComponent(name)}`}>Open this strategy as a Maker →</Link></p>
      <p className={aqua.hint}>PinTool manages the parent namespace. Your resolver permissions control its records; parent administrators retain control of the name hierarchy.</p>
    </>}
    <ActionFeedback progress={progress} error={error} success={success} />
  </section>;
}

export function ActionFeedback({ progress, error, success }: { progress: EnsProgress | null; error: string; success: string }) {
  return <>{progress && <p role="status" className={styles.feedback}>{progress.title}{progress.hash && <> · <a target="_blank" rel="noreferrer" href={`https://sepolia.etherscan.io/tx/${progress.hash}`}>View transaction</a></>}</p>}
    {error && <p role="alert" className={`${aqua.fieldError} ${styles.feedback}`}>{error}</p>}{success && <p role="status" className={styles.feedback}>{success}</p>}</>;
}
