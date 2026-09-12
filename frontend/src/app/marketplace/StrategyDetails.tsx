import type React from 'react';
import type { Listing } from './publishedStore';
import { ListingCard } from './ui';
import aqua from './aqua.module.css';

export default function StrategyDetails({ listing, action }: { listing: Listing; action: React.ReactNode }) {
  return <div className={aqua.decisionGrid}>
    <div className={aqua.previewColumn}>
      <ListingCard listing={listing} />
      {action}
    </div>
    <aside className={aqua.explanation}>
      <span className={aqua.eyebrow}>Strategy specifications</span>
      <h2>Liquidity configuration</h2>
      <div className={aqua.intentRows}>
        <div><span>Pair</span><strong>WETH / USDC</strong></div>
        <div><span>Mechanism</span><strong>{listing.template.mechanism}</strong></div>
        <div><span>Custody</span><strong>Maker wallet</strong></div>
        <div><span>Provider policy</span><strong>{listing.template.privateInputs}</strong></div>
        {listing.executionProfileIds && <div><span>Execution profiles</span><strong>Tight · Defensive · Paused</strong></div>}
      </div>
      <h3>Risk to understand</h3>
      <p>{listing.template.risk}</p>
      <p className={aqua.muted}>Reviewing a strategy does not reveal its Provider&apos;s private policy. Your own limits are applied before it can be authorized.</p>
    </aside>
  </div>;
}
