import React from 'react';
import Avatar from '../components/shared/Avatar';
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

export function PageHead({ eyebrow, title, accent, children, headingRef }: { eyebrow: string; title: string; accent?: string; children?: React.ReactNode; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return <div className={aqua.pageHead}>
    <span className={aqua.eyebrow}>{eyebrow}</span>
    <h1 ref={headingRef} tabIndex={-1}>{title}{accent && <span>{accent}</span>}</h1>
    {children && <p>{children}</p>}
  </div>;
}

export function ListingCard({ listing, action }: { listing: Listing; action?: React.ReactNode }) {
  return <article className={`${styles.card} ${aqua.card}`}>
    <div className={styles.cardBg} aria-hidden="true" />
    <div className={`${styles.cardBody} ${action ? '' : aqua.cardBodyEnd}`}>
      <div className={styles.tagRow}>
        <span className={`${styles.tag} ${aqua.chip}`}>{listing.template.label}</span>
        {listing.mine && <span className={`${styles.tag} ${aqua.chip} ${aqua.mineTag}`}>Your strategy</span>}
      </div>
      <h3 className={styles.cardTitle}>{listing.name}</h3>
      {listing.provider && <p className={aqua.byline}><Avatar name={listing.provider} src={listing.providerAvatar} size={24} brand={listing.provider === 'PinTool Strategies'} />by <span>{listing.provider}</span></p>}
      {listing.feePct !== undefined && <p className={aqua.feeLine}>{listing.feePct === 0 ? 'No fee' : `Fee: ${listing.feePct}% of profit`}</p>}
      <p className={`${aqua.summary} ${aqua.preserveLines}`}>{listing.summary}</p>
    </div>
    {action && <div className={`${styles.cardActions} ${aqua.cardActions}`}>{action}</div>}
  </article>;
}
