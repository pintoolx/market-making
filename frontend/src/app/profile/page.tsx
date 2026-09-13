'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import { useAccount } from '../providers/useAccount';
import { usePublishedListings } from '../marketplace/publishedStore';
import MyLiquidity from './MyLiquidity';
import { ListingCard } from '../marketplace/ui';
import AccountDetails from './AccountDetails';
import EnsWorkspace from '../ens/EnsWorkspace';
import EnsPublisher from '../ens/EnsPublisher';
import Avatar from '../components/shared/Avatar';
import ConfirmButton from './ConfirmButton';
import CopyAddress from './CopyAddress';
import { useBasicProfile } from './profileStore';
import styles from '../marketplace/page.module.css';
import aqua from '../marketplace/aqua.module.css';

type Tab = 'providing' | 'making' | 'account';

function Tabs({ tab, setTab, showAccount }: { tab: Tab; setTab: (tab: Tab) => void; showAccount: boolean }) {
  return <div className={aqua.filters} aria-label="Profile sections">
    <Secondary aria-pressed={tab === 'providing'} onClick={() => setTab('providing')}>Providing</Secondary>
    <Secondary aria-pressed={tab === 'making'} onClick={() => setTab('making')}>My liquidity</Secondary>
    {showAccount && <Secondary aria-pressed={tab === 'account'} onClick={() => setTab('account')}>Account</Secondary>}
  </div>;
}

function Empty({ title, text, action, href }: { title: string; text: string; action: string; href: string }) {
  const router = useRouter();
  return <div className={`${aqua.panel} ${aqua.emptyPanel}`}>
    <h2 className={aqua.sectionTitle}>{title}</h2>
    <p className={aqua.muted}>{text}</p>
    <div><Primary onClick={() => router.push(href)}>{action}</Primary></div>
  </div>;
}

function Providing() {
  const router = useRouter();
  const { published: allPublished, unpublish } = usePublishedListings();
  const published = allPublished.filter(item => item.mine);
  if (!published.length) return <Empty title="No strategies yet" text="Start from one of six Aqua templates and publish your first strategy." action="Open Provider Studio" href="/studio" />;
  return <>
    <div className={aqua.sectionTop}>
      <h2 className={aqua.sectionTitle}>Strategies you provide</h2>
      <span className={aqua.muted}>{published.length} published</span>
    </div>
    <div className={aqua.grid}>
      {published.map(item => <ListingCard key={item.id} listing={item} action={<div className={aqua.cardButtons}>
        <Primary onClick={() => router.push(`/studio?edit=${item.template.id}`)}>Edit</Primary>
        {!item.releaseId && <ConfirmButton label="Unpublish" confirmLabel="Yes, unpublish" onConfirm={() => unpublish(item.template.id)} />}
      </div>} />)}
    </div>
  </>;
}

// Same shell as the marketplace pages. Strategies come first; profile details live in the Account tab.
export default function ProfilePage() {
  const account = useAccount();
  const { profile, save } = useBasicProfile(account.userId ?? 'guest');
  const [tab, setTab] = useState<Tab>('providing');
  const selectTab = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, '', next === 'providing' ? '/profile' : `/profile?tab=${next}`);
  };
  // /profile?tab=making (or account) opens that tab directly.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'making' || requested === 'account') setTab(requested);
  }, []);
  const signedIn = account.authenticated;
  const name = profile.displayName || 'Unnamed account';
  const current = !signedIn && tab === 'account' ? 'providing' : tab;

  return (
    <div className={`${styles.page} ${aqua.page}`}>
      <SiteHeader />
      <main className={styles.mainScroll}>
        <div className={styles.main}>
          <section className={aqua.flow}>
            {!account.ready ? <p className={aqua.muted}>Loading your profile…</p> : <>
              <div className={aqua.identity}>
                {signedIn && <Avatar name={name} src={profile.avatar} />}
                <div className={aqua.identityText}>
                  <h1>{signedIn ? name : 'Your profile'}</h1>
                  <p>{signedIn
                    ? <>{account.method}{account.address && <> · <CopyAddress address={account.address} short /></>}</>
                    : account.enabled ? 'Log in at the top right to put your name on strategies and keep your profile.' : 'Login is not configured: add NEXT_PUBLIC_PRIVY_APP_ID.'}</p>
                </div>
              </div>
              <Tabs tab={current} setTab={selectTab} showAccount={signedIn} />
              {current === 'account'
                ? <><AccountDetails key={account.userId} profile={profile} onSave={save} loginMethod={account.method} email={account.email} wallet={account.address} walletNote={account.embedded ? 'Created by Privy for your email login' : undefined} />
                  <EnsWorkspace key={account.address} account={account} mode="identity" />
                  <details><summary>Advanced · Publish for another Provider</summary><EnsPublisher key={account.address} account={account} /></details></>
                : current === 'making' ? <MyLiquidity key={`${account.authenticated}:${account.addresses.map(address => address.toLowerCase()).sort().join(',')}`} account={account} /> : <Providing />}
            </>}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
