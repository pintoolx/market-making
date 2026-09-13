import React from 'react';
import ProviderIdentity from './ProviderIdentity';
import type { Listing } from './publishedStore';
import styles from './page.module.css';
import aqua from './aqua.module.css';

// Layout pieces shared by AquaApp (/, /studio, /maker) and /profile.
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return <ol className={aqua.steps} aria-label="Progress" style={{ '--step-count': steps.length } as React.CSSProperties}>
    {steps.map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined} data-done={index < current || undefined}>
      <span>{index + 1}</span>{label}
    </li>)}
  </ol>;
}

export function ListingGrid({ children }: { children: React.ReactNode }) {
  return <div className={`${styles.grid} ${aqua.grid}`}>{children}</div>;
}

export function PageHead({ eyebrow, title, accent, children, headingRef }: { eyebrow: string; title: string; accent?: string; children?: React.ReactNode; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return <div className={aqua.pageHead}>
    <span className={aqua.eyebrow}>{eyebrow}</span>
    <h1 ref={headingRef} tabIndex={-1}>{title}{accent && <span>{accent}</span>}</h1>
    {children && <p>{children}</p>}
  </div>;
}

export function StrategyCardShell({ tags, title, children, action }: {
  tags: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const bodyClassName = action ? styles.cardBody : `${styles.cardBody} ${aqua.cardBodyEnd}`;

  return <article className={`${styles.card} ${aqua.card}`}>
    <div className={styles.cardBg} aria-hidden="true" />
    <div className={bodyClassName}>
      <div className={styles.tagRow}>{tags}</div>
      <h3 className={styles.cardTitle}>{title}</h3>
      {children}
    </div>
    {action && <div className={`${styles.cardActions} ${aqua.cardActions}`}>{action}</div>}
  </article>;
}

export function ListingCard({ listing, action }: { listing: Listing; action?: React.ReactNode }) {
  const tags = <>
        <span className={`${styles.tag} ${aqua.chip}`}>{listing.template.mechanism}</span>
        <span className={`${styles.tag} ${aqua.chip}`}>{listing.template.category}</span>
        {listing.version && <span className={`${styles.tag} ${aqua.chip}`}>Version {listing.version}</span>}
        {listing.mine && <span className={`${styles.tag} ${aqua.chip} ${aqua.mineTag}`}>Your strategy</span>}
        {listing.executionReady && <span className={`${styles.tag} ${aqua.chip} ${aqua.liveTag}`}>Accepting liquidity</span>}
  </>;

  return <StrategyCardShell tags={tags} title={listing.name} action={action}>
      <p className={`${aqua.summary} ${aqua.preserveLines}`}>{listing.summary}</p>
      <div className={aqua.cardRule}>
        <span className={aqua.eyebrow}>Strategy provider</span>
      {(listing.ensName || listing.ensSelection) && <p className={`${aqua.byline} ${aqua.strategyName}`}>{listing.ensName ?? listing.ensSelection!.name}</p>}
      {listing.ensStatus === 'historical' && <p className={aqua.muted}>Previously published under this name. ENS now points to another version.</p>}
      <ProviderIdentity listing={listing} />
      {listing.feePct !== undefined && <p className={aqua.feeLine}>{listing.feePct === 0 ? 'No fee' : `Proposed profit share: ${listing.feePct}% · collection not enabled`}</p>}
      </div>
  </StrategyCardShell>;
}
