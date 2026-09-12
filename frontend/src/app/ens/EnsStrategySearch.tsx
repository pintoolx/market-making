'use client';
import { useEffect, useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import FormInput from '../components/shared/FormInput';
import { resolveEnsStrategy, type EnsResolution } from './ensClient';
import aqua from '../marketplace/aqua.module.css';
import styles from './ens.module.css';
import { request } from '../marketplace/mandateClient';

export default function EnsStrategySearch({ onSelect }: { onSelect: (result: EnsResolution) => void }) {
  const [name, setName] = useState('');
  const [result, setResult] = useState<EnsResolution | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<{ name: string; verified: boolean }[]>([]);
  const generation = useRef(0);
  const initial = useRef<string | null | undefined>(undefined);
  const resolve = async (value: string) => {
    const token = ++generation.current; setBusy(true); setError(''); setResult(null);
    try { const resolved = await resolveEnsStrategy(value); if (token === generation.current) setResult(resolved); }
    catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : 'The ENS strategy could not be verified. Retry when Sepolia is available.'); }
    finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => {
    const activeGeneration = generation;
    if (initial.current === undefined) initial.current = new URLSearchParams(window.location.search).get('ens');
    if (initial.current) { setName(initial.current); void resolve(initial.current); }
    return () => { activeGeneration.current++; };
  }, []);
  useEffect(() => {
    let alive = true;
    request<{ names: { name: string; verified: boolean }[] }>('/v1/ens/names').then(data => { if (alive) setKnown(data.names); }).catch(() => { /* Explicit name resolution remains available when indexing fails. */ });
    return () => { alive = false; };
  }, []);
  return <section className={`${aqua.panel} ${styles.workspace}`} aria-label="Find a strategy by ENS">
    <h2>Find a strategy by ENS</h2>
    <form className={styles.search} onSubmit={e => { e.preventDefault(); void resolve(name); }} aria-busy={busy}>
      <label>Strategy name<FormInput required value={name} autoComplete="off" spellCheck={false} placeholder="eth-usdc.alice.pintool.eth" onChange={e => { generation.current++; setBusy(false); setName(e.target.value); setResult(null); setError(''); }} /></label>
      <Primary type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Resolve strategy'}</Primary>
    </form>
    <p className={aqua.hint}>Checks Sepolia ENS ownership, the published version and its Provider signature. You choose and keep a specific version.</p>
    {known.length > 0 && <div className={styles.knownNames} aria-label="Published strategy names">{known.map(item => <button type="button" key={item.name} disabled={busy} onClick={() => { setName(item.name); void resolve(item.name); }}>{item.name}{!item.verified && ' · refresh to verify'}</button>)}</div>}
    {error && <p role="alert" className={`${aqua.fieldError} ${styles.feedback}`}>{error}</p>}
    {result && <div className={styles.result}>
      <strong className={styles.name}>{result.name}</strong><p>{result.manifest.release.name} · version {result.pointer.version}</p>
      <p>{result.manifest.release.summary}</p>
      <p className={styles.feedback}>Provider signature verified · Sepolia block {result.blockNumber}</p>
      <Primary onClick={() => onSelect(result)}>Review this version</Primary>
    </div>}
  </section>;
}
