'use client';

import { Suspense, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Primary from '../components/shared/Primary';
import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import ProviderFlow from './ProviderFlow';
import MakerFlow from './MakerFlow';
import styles from './page.module.css';
import aqua from './aqua.module.css';

export type Screen = 'home' | 'provider' | 'maker';
const PATHS: Record<Screen, string> = { home: '/', provider: '/studio', maker: '/maker' };

// Shared shell; route changes determine the active flow without forced remounts.
export default function AquaApp({ screen }: { screen: Screen }) {
  const router = useRouter();
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollTop = () => pageRef.current?.scrollTo({ top: 0 });
  const goTo = (next: Screen) => router.push(PATHS[next]);

  // Everything on the home screen fits one desktop viewport: pitch + role choice on top, architecture below.
  const home = <div className={aqua.home}>
    <section className={aqua.homeTop} aria-label="Choose a role">
      <div className={aqua.homeIntro}>
        <span className={aqua.eyebrow}>Confidential market making · self-custodial liquidity</span>
        <h1>Run private market-making strategies.<span>Keep liquidity in your wallet.</span></h1>
        <p>Strategy providers submit encrypted trading rules. Makers submit encrypted capital limits. PinTool authorizes only the swaps that satisfy both.</p>
      </div>
      <div className={aqua.roleChoices}>
        <article className={`${styles.card} ${aqua.roleCard}`}>
          <div className={styles.cardBg} aria-hidden="true" />
          <div className={aqua.roleBody}>
            <span className={aqua.roleNumber}>Strategy Provider</span>
            <h2>Design strategies</h2>
            <ul><li>Start from a supported market-making model</li><li>Add your signals, rules and limits</li><li>Publish strategies for makers</li></ul>
          </div>
          <div className={aqua.roleAction}><Primary onClick={() => goTo('provider')}>Create a strategy</Primary></div>
        </article>
        <article className={`${styles.card} ${aqua.roleCard}`}>
          <div className={styles.cardBg} aria-hidden="true" />
          <div className={aqua.roleBody}>
            <span className={aqua.roleNumber}>Maker</span>
            <h2>Put liquidity to work</h2>
            <ul><li>Compare published strategies</li><li>Set limits without revealing them</li><li>Keep funds in your wallet until settlement</li></ul>
          </div>
          <div className={aqua.roleAction}><Primary onClick={() => goTo('maker')}>Choose a strategy</Primary></div>
        </article>
      </div>
    </section>
    <section className={aqua.architecture} aria-labelledby="architecture-title">
      <div className={aqua.architectureHeading}>
        <span className={aqua.eyebrow}>Private matching and settlement</span>
        <h2 id="architecture-title">From private rules to an authorized swap.</h2>
        <p>Provider logic and maker limits are encrypted separately and evaluated inside Chainlink&apos;s TEE.</p>
      </div>
      <div className={aqua.architectureDiagram}>
        <div className={`${aqua.archNode} ${aqua.providerNode}`}>
          <span className={aqua.archStep}>Strategy Provider</span>
          <strong>Private strategy policy</strong>
          <small>Signals · pricing rules · adjustment thresholds</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.providerConnector}`} aria-hidden="true"><span>encrypted</span></div>
        <div className={`${aqua.archNode} ${aqua.makerNode}`}>
          <span className={aqua.archStep}>Maker</span>
          <strong>Private liquidity limits</strong>
          <small>Capital limit · inventory exposure · allowed assets</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.makerConnector}`} aria-hidden="true"><span>encrypted</span></div>
        <div className={`${aqua.archNode} ${aqua.teeNode}`}>
          <span className={aqua.archStep}>Chainlink TEE</span>
          <strong>Evaluate privately</strong>
          <small>Combine rules · reject conflicts · authorize execution</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.outputConnector}`} aria-hidden="true"><span>authorization</span></div>
        <div className={`${aqua.archNode} ${aqua.aquaNode}`}>
          <span className={aqua.archStep}>1inch Aqua / SwapVM</span>
          <strong>Settle approved swaps</strong>
          <small>Uses only the liquidity authorized by the maker</small>
        </div>
      </div>
    </section>
  </div>;

  return (
    <div ref={pageRef} data-marketplace-scroll={screen === 'maker' ? true : undefined} className={`${styles.page} ${aqua.page}`}>
      <SiteHeader role={screen === 'home' ? null : screen} showRoles={screen !== 'home'} />
      <main className={styles.mainScroll}>
        <div className={`${styles.main} ${screen === 'home' ? aqua.mainHome : ''}`}>
          {screen === 'home' ? home
            : screen === 'provider' ? <Suspense fallback={<p role="status">Loading your workspace…</p>}><ProviderFlow scrollTop={scrollTop} /></Suspense>
            : <Suspense fallback={<p role="status">Loading strategies…</p>}><MakerFlow scrollTop={scrollTop} /></Suspense>}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
