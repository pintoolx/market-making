'use client';
import { useState } from 'react';
import type { Account } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import FormInput from '../components/shared/FormInput';
import { request } from '../marketplace/mandateClient';
import { ensTransactions, type EnsProgress } from '../../../../shared/ens/transactions.mjs';
import { getEnsConfig, ensClient, ensError, verifyManifest, type PublicManifest } from './ensClient';
import { ActionFeedback } from './EnsWorkspace';
import aqua from '../marketplace/aqua.module.css';
import styles from './ens.module.css';

export default function EnsPublisher({ account }: { account: Account }) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [progress, setProgress] = useState<EnsProgress | null>(null);
  const publish = async () => {
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!account.ensWallet || !/^[1-9][0-9]{0,6}$/.test(version)) throw new Error('Connect your publisher wallet and enter an approved version number.');
      const { rootName } = await getEnsConfig();
      // Ownership is read from ENS, never accepted from a free-text provider field.
      const { createEnsReader } = await import('../../../../shared/ens/chain.mjs');
      const owner = await createEnsReader({ rootName, client: ensClient }).describeName(name);
      const id = `${owner.provider.slice(2)}-clmm`;
      const manifest = await request<PublicManifest>(`/v1/ens/manifest?name=${encodeURIComponent(owner.name)}&releaseId=${id}&version=${version}`);
      await verifyManifest(manifest, rootName);
      const tx = ensTransactions(ensClient, await account.ensWallet(), setProgress);
      await tx.publishPointer(rootName, owner.name, manifest.pointer);
      setSuccess(`Published approved version ${version}. Existing Maker selections remain unchanged.`);
      window.dispatchEvent(new Event('pintool:published-changed'));
    } catch (e) { setError(ensError(e)); }
    finally { setBusy(false); }
  };
  return <section className={`${aqua.panel} ${styles.workspace}`}>
    <h2>Publish on behalf of a Provider</h2>
    <p>Use your delegated wallet to update a strategy entry to a version its Provider has already signed.</p>
    <form onSubmit={e => { e.preventDefault(); void publish(); }} aria-busy={busy}>
      <fieldset disabled={busy}><legend>Approved version</legend>
        <label>Strategy ENS name<FormInput required autoComplete="off" spellCheck={false} value={name} onChange={e => setName(e.target.value)} placeholder="eth-usdc.alice.pintool.eth" /></label>
        <label>Version number<FormInput required inputMode="numeric" autoComplete="off" value={version} onChange={e => setVersion(e.target.value)} placeholder="2" /></label>
        {account.authenticated ? <Primary type="submit">Publish as delegate</Primary> : <Primary type="button" onClick={account.login}>Connect publisher wallet</Primary>}
      </fieldset>
    </form>
    <ActionFeedback progress={progress} error={error} success={success} />
  </section>;
}
