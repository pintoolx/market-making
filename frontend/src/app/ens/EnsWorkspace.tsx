'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { type Address } from 'viem';
import type { Account } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import CopyAddress from '../profile/CopyAddress';
import { request } from '../marketplace/mandateClient';
import type { PublicRelease } from '../marketplace/ClmmPublisher';
import { ensTransactions, type EnsProgress } from '../../../../shared/ens/transactions.mjs';
import { manifestMessage, RELEASE_KEY } from '../../../../shared/ens/schema.mjs';
import { ensClient, ensError, getEnsConfig, getEnsStatus, resolveEnsStrategy, verifyManifest, type EnsStatus, type PublicManifest } from './ensClient';
import aqua from '../marketplace/aqua.module.css';
import styles from './ens.module.css';

export default function EnsWorkspace({ account, release, mode = 'strategy' }: { account: Account; release?: PublicRelease | null; mode?: 'identity' | 'strategy' }) {
  const [root, setRoot] = useState('');
  const [status, setStatus] = useState<EnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [providerLabel, setProviderLabel] = useState('');
  const [strategyLabel, setStrategyLabel] = useState('eth-usdc');
  const [delegateAddress, setDelegateAddress] = useState('');
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const latest = release ?? null;
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

  return <section className={`${aqua.panel} ${styles.workspace}`} aria-label={mode === 'identity' ? 'Strategy provider name' : 'Strategy name and sharing'} aria-busy={busy}>
    <div className={styles.heading}><div><h2>{mode === 'identity' ? 'Strategy provider name' : 'Shareable strategy name'}</h2></div><Secondary disabled={loading || busy} onClick={() => void refresh()}>Refresh ENS</Secondary></div>
    <p>{mode === 'identity' ? 'Verify strategies published by this wallet.' : 'Create a verified link for makers.'}</p>
    {loading && <p role="status" className={styles.skeleton}>Checking the platform namespace…</p>}
    {statusError && <div role="status" className={styles.notice}><p>{statusError}</p></div>}
    {!account.authenticated ? <Primary onClick={account.login}>Log in</Primary>
      : !account.walletConnected && <Primary onClick={account.connectWallet}>Connect publishing wallet</Primary>}
    {status && account.authenticated && !status.provider && mode === 'identity' && <form onSubmit={e => { e.preventDefault(); void act(async tx => {
      await tx.claimProvider(root, providerLabel); await refresh(); setSuccess('Your provider name is ready.');
    }); }}>
      <fieldset disabled={busy}><legend>Claim your provider name</legend>
        <label>Name<FormInput required autoComplete="off" spellCheck={false} minLength={3} maxLength={32} value={providerLabel} onChange={e => setProviderLabel(e.target.value)} placeholder="alice" /></label>
        <p className={aqua.hint}>{providerLabel || 'alice'}.{root} · One name per wallet · Uses Sepolia ETH</p>
        <Primary type="submit" disabled={!account.walletConnected}>Claim name</Primary>
      </fieldset>
    </form>}
    {status && account.authenticated && !status.provider && mode === 'strategy' && <p><Link href="/profile?tab=account">Claim a provider name in Profile →</Link></p>}
    {status?.provider && mode === 'identity' && <div className={styles.identity}><strong>{status.provider.name}</strong><CopyAddress address={account.address!} /><Link href="/studio">Create a strategy →</Link></div>}
    {status?.provider && mode === 'strategy' && !latest && <p>Publish a strategy before assigning a name.</p>}
    {status?.provider && mode === 'strategy' && latest && <>
      <div className={styles.identity}><strong>{status.provider.name}</strong><span className={styles.walletIdentity}>Publishing wallet <CopyAddress address={account.address!} short /></span></div>
      <fieldset disabled={busy}>
        <legend>Shareable ENS name</legend>
        <label>Name<FormInput value={strategyLabel} autoComplete="off" spellCheck={false} minLength={3} maxLength={32} onChange={e => setStrategyLabel(e.target.value)} /></label>
        <p className={styles.name}>{name}</p>
        <p>{latest?.state === 'published' ? `${latest.name} · Revision ${latest.version}` : 'Publish this strategy before assigning a name.'}</p>
        <div className={aqua.actionRow}><Primary disabled={!account.walletConnected || !latest || latest.state !== 'published'} onClick={approve}>Approve strategy</Primary><Secondary disabled={!account.walletConnected || !latest || latest.state !== 'published'} onClick={publish}>Publish ENS link</Secondary></div>
        {currentVersion && <p role="status">ENS points to revision {currentVersion}.</p>}
        <p className={aqua.hint}>Approve the strategy first, then publish its ENS link.</p>
      </fieldset>
      <details className={styles.advanced}><summary>Advanced · Publisher permissions</summary>
      <form onSubmit={e => { e.preventDefault(); void act(async tx => { await tx.delegate(root, name, delegateAddress as Address, true); setSuccess('Publisher can update this strategy’s version record.'); }); }}>
        <fieldset disabled={busy}><legend>Delegate version updates</legend>
          <label>Publisher wallet<FormInput required value={delegateAddress} autoComplete="off" spellCheck={false} placeholder="0x…" onChange={e => setDelegateAddress(e.target.value)} /></label>
          <p className={aqua.hint}>This grants access to the {RELEASE_KEY} record on {name}. The publisher can use only versions you have signed and cannot access maker funds.</p>
          <div className={aqua.actionRow}><Primary type="submit">Authorize publisher</Primary><Secondary type="button" onClick={() => void act(async tx => { await tx.delegate(root, name, delegateAddress as Address, false); setSuccess('Publisher access revoked and checked onchain.'); })}>Revoke publisher</Secondary></div>
        </fieldset>
      </form>
      </details>
      <p><Link href={`/strategy?ens=${encodeURIComponent(name)}`}>Open verified strategy →</Link></p>
    </>}
    <ActionFeedback progress={progress} error={error} success={success} />
  </section>;
}

export function ActionFeedback({ progress, error, success }: { progress: EnsProgress | null; error: string; success: string }) {
  return <>{progress && <p role="status" className={styles.feedback}>{progress.title}{progress.hash && <> · <a target="_blank" rel="noreferrer" href={`https://sepolia.etherscan.io/tx/${progress.hash}`}>View transaction</a></>}</p>}
    {error && <p role="alert" className={`${aqua.fieldError} ${styles.feedback}`}>{error}</p>}{success && <p role="status" className={styles.feedback}>{success}</p>}</>;
}
