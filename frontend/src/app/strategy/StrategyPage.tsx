'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import { useAccount } from '../providers/useAccount';
import { getExecutableStrategies } from '../marketplace/mandateClient';
import { loadStrategyListing } from '../marketplace/strategyCatalog';
import { prepareMarketplaceReturn, strategyHref } from '../marketplace/strategyLinks';
import type { Listing } from '../marketplace/publishedStore';
import StrategyDetails from '../marketplace/StrategyDetails';
import { PageHead } from '../marketplace/ui';
import { discoverStrategyNames } from '../ens/strategyNames';
import { resolveEnsStrategy } from '../ens/ensClient';
import styles from '../marketplace/page.module.css';
import aqua from '../marketplace/aqua.module.css';
import primary from '../components/shared/Primary.module.css';

export default function StrategyPage() {
  const account = useAccount();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const ens = params.get('ens');
  const routeKey = JSON.stringify([id, ens]);
  const [loaded, setLoaded] = useState<{ key: string; listing: Listing } | null>(null);
  const listing = loaded?.key === routeKey ? loaded.listing : null;
  const [error, setError] = useState('');
  const [checkingNames, setCheckingNames] = useState(false);
  const [catalog, setCatalog] = useState<{ maker: string; ids: string[] } | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [back, setBack] = useState('/maker');
  const [copied, setCopied] = useState('');

  // Rearm on forward navigation and direct visits, so Back always opens the
  // marketplace instead of restoring a previously saved Maker mandate.
  useEffect(() => { setBack(prepareMarketplaceReturn().url); }, [routeKey]);
  useEffect(() => {
    let alive = true;
    getExecutableStrategies().then(value => { if (alive) setCatalog({ maker: value.maker.toLowerCase(), ids: value.strategies.map(s => s.id) }); })
      .catch(() => { if (alive) setCatalogError(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    setLoaded(null); setError(''); setCopied(''); setCheckingNames(true);
    const load = async () => {
      if (!id) {
        if (!ens) throw new Error('Choose a strategy from the marketplace or open a strategy link.');
        const resolved = await resolveEnsStrategy(ens);
        if (alive) router.replace(strategyHref(`${resolved.pointer.releaseId}.v${resolved.pointer.version}`, resolved.name));
        return;
      }
      const base = await loadStrategyListing(id);
      if (!alive) return;
      setLoaded({ key: routeKey, listing: base });
      const names = await discoverStrategyNames(base, ens ?? undefined);
      if (alive) setLoaded({ key: routeKey, listing: { ...base, ...names } });
    };
    load().catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'This strategy could not be loaded.'); })
      .finally(() => { if (alive) setCheckingNames(false); });
    return () => { alive = false; };
  }, [id, ens, routeKey, router]);

  const maker = account.addresses.find(address => address.toLowerCase() === catalog?.maker);
  const executable = !!listing && !!maker && (listing.executionProfileIds ?? [listing.id]).every(value => catalog?.ids.includes(value));
  const canActivate = !!maker && !!listing?.releaseId;
  const useLink = listing ? '/maker?' + new URLSearchParams({ strategy: listing.id, start: '1',
    ...(listing.ensSelection ? { ens: listing.ensSelection.name } : {}) }) : '/maker';
  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied('Link copied'); }
    catch { setCopied('Copy the URL from your browser to share this version.'); }
  };
  const action = <>
    {!account.authenticated ? <Primary onClick={account.login}>Connect Maker wallet</Primary>
      : !catalog || checkingNames ? <Primary disabled>{catalogError ? 'Availability unavailable' : 'Checking availability…'}</Primary>
        : listing?.ensError ? <p role="alert" className={aqua.muted}>{listing.ensError} Open the strategy again from the marketplace to review it by publication ID.</p>
          : executable || canActivate ? <Link href={useLink} className={primary.primary}>{executable ? 'Use this strategy' : 'Enable this strategy'}</Link>
            : <p className={aqua.muted}>This strategy is not available for the connected wallet.</p>}
  </>;

  return <div className={`${styles.page} ${aqua.page}`}><SiteHeader role="maker" />
    <main className={`${styles.main} ${aqua.flow}`}>
      <Link href={back} className={aqua.backLink}>← Strategy marketplace</Link>
      <PageHead eyebrow="Strategy details" title={listing?.name ?? 'Strategy details'}>Review this version before using it with your liquidity.</PageHead>
      {error && <p role="alert" className={aqua.errorNotice}>{error}</p>}
      {!listing && !error && <p role="status">Loading strategy…</p>}
      {listing && <>
        <div className={aqua.actionRow}><Secondary onClick={copy}>Copy strategy link</Secondary><span role="status">{copied}</span></div>
        <StrategyDetails listing={{ ...listing, executionReady: executable }} action={action} />
        {checkingNames && <p role="status" className={aqua.muted}>Checking ENS names…</p>}
        {listing.ensError && <p role="status" className={aqua.muted}>{listing.ensError} The publication version is still shown above.</p>}
      </>}
    </main><SiteFooter /></div>;
}
