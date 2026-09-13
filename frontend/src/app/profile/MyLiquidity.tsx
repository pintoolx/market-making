'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Account } from '../providers/useAccount';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import { listMandates, type MandateSummary } from '../marketplace/mandateClient';
import { ADAPTIVE_PROFILE_IDS } from '../marketplace/mandatePresentation';
import { ListingGrid, StrategyCardShell } from '../marketplace/ui';
import aqua from '../marketplace/aqua.module.css';
import page from '../marketplace/page.module.css';
import primary from '../components/shared/Primary.module.css';
import secondary from '../components/shared/Secondary.module.css';
import liquidity from './liquidity.module.css';

const nameOf = (item: MandateSummary) => item.strategies.every(strategy => ADAPTIVE_PROFILE_IDS.some(id => id === strategy.listingId))
  ? 'Adaptive Market Maker' : item.strategies.map(strategy => strategy.name).join(' + ');
const activityOf = (value: string | null) => value
  ? `${new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
  : 'Not recorded';

export default function MyLiquidity({ account }: { account: Account }) {
  const [items, setItems] = useState<MandateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const walletKey = [...new Set(account.addresses.filter(address => /^0x[0-9a-f]{40}$/i.test(address)).map(address => address.toLowerCase()))].sort().join(',');

  useEffect(() => {
    let current = true;
    setItems([]); setError('');
    if (!account.authenticated || !walletKey) { setLoading(false); return; }
    setLoading(true);
    Promise.all(walletKey.split(',').map(listMandates))
      .then(groups => {
        if (!current) return;
        const unique = [...new Map(groups.flat().map(item => [item.mandateId, item])).values()];
        unique.sort((a, b) => (Date.parse(b.lastActivityAt ?? '') || 0) - (Date.parse(a.lastActivityAt ?? '') || 0));
        setItems(unique);
      })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'Your liquidity could not be loaded.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [account.authenticated, walletKey, revision]);

  if (!account.authenticated) return <div className={aqua.empty}>
    <h2>Your liquidity, in one place.</h2><p>Log in to view and manage your strategies.</p>
    <Primary onClick={account.login}>Log in</Primary>
  </div>;
  if (!walletKey) return <p>Connect an Ethereum wallet to view your liquidity.</p>;
  if (loading) return <p role="status">Loading your liquidity…</p>;
  if (error) return <div className={aqua.errorNotice} role="alert"><strong>Unable to load your liquidity</strong><span>{error}</span><Secondary onClick={() => setRevision(value => value + 1)}>Retry</Secondary></div>;
  if (!items.length) return <div className={aqua.empty}>
    <h2>No liquidity strategies yet</h2><p>Choose a strategy and set your limits to get started.</p>
    <Link className={secondary.secondary} href="/maker">Explore strategies</Link>
  </div>;

  return <>
    <div className={aqua.sectionTop}><h2 className={aqua.sectionTitle}>My liquidity</h2><span className={aqua.muted}>{items.length} {items.length === 1 ? 'setup' : 'setups'}</span></div>
    <ListingGrid>
      {items.map(item => {
        const tags = <>
          <span className={`${page.tag} ${aqua.chip}`}>{item.networkName}</span>
          <span className={`${page.tag} ${aqua.chip}`}>Private mandate</span>
        </>;
        const action = <Link className={primary.primary} href={`/maker?mandate=${encodeURIComponent(item.mandateId)}`}>Manage liquidity</Link>;

        return <StrategyCardShell key={item.mandateId} tags={tags} title={nameOf(item)} action={action}>
          <p className={aqua.summary}>One Maker balance governed by your private liquidity limits.</p>
          <div className={aqua.cardRule}>
            <span className={aqua.eyebrow}>Latest activity</span>
            <div className={liquidity.details}>
              <span><time dateTime={item.lastActivityAt ?? undefined}>{activityOf(item.lastActivityAt)}</time></span>
              <span>Report {item.reportSequence}</span>
              {walletKey.includes(',') && <span>Wallet {item.maker.slice(0, 6)}…{item.maker.slice(-4)}</span>}
              <span title={item.mandateId}>Reference {item.mandateId.slice(8, 16)}</span>
            </div>
          </div>
        </StrategyCardShell>;
      })}
    </ListingGrid>
  </>;
}
