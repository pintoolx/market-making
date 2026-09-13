import type React from 'react';
import type { Listing } from './publishedStore';
import ProviderIdentity from './ProviderIdentity';
import aqua from './aqua.module.css';

export default function StrategyDetails({ listing, action }: { listing: Listing; action: React.ReactNode }) {
  return <div className={aqua.decisionGrid}>
    <div className={aqua.previewColumn}>
      <section className={aqua.panel} aria-label={`${listing.name} overview`}>
        <p className={`${aqua.summary} ${aqua.preserveLines}`}>{listing.summary}</p>
        <div className={aqua.cardRule}>
          <span className={aqua.eyebrow}>Provided by</span>
          <ProviderIdentity listing={listing} />
        </div>
        {action}
      </section>
    </div>
    <aside className={aqua.explanation}>
      <span className={aqua.eyebrow}>Public configuration</span>
      <h2>How this strategy uses liquidity</h2>
      <div className={aqua.intentRows}>
        <div><span>Pair</span><strong>WETH / USDC</strong></div>
        <div><span>Mechanism</span><strong>{listing.template.mechanism}</strong></div>
        <div><span>Funds remain in</span><strong>Your wallet</strong></div>
        <div><span>Confidential policy</span><strong>{listing.template.privateInputs}</strong></div>
        {listing.executionProfileIds && <div><span>Available modes</span><strong>Tight · Defensive · Paused</strong></div>}
      </div>
      <h3>Main risk</h3>
      <p>{listing.template.risk}</p>
      <p className={aqua.muted}>The provider&apos;s rules remain confidential. PinTool applies your private limits before authorizing any mode.</p>
    </aside>
  </div>;
}
