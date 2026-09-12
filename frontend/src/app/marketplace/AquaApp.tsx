'use client';

import { useRef, useState } from 'react';
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

// Shell for /, /studio and /maker. Each flow keeps its own steps; re-clicking the current role tab restarts it.
export default function AquaApp({ screen }: { screen: Screen }) {
  const router = useRouter();
  const pageRef = useRef<HTMLDivElement>(null);
  const [restart, setRestart] = useState(0);
  const scrollTop = () => pageRef.current?.scrollTo({ top: 0 });
  const goTo = (next: Screen) => {
    if (next !== screen) { router.push(PATHS[next]); return; }
    scrollTop();
    setRestart(n => n + 1);
  };

  // Everything on the home screen fits one desktop viewport: pitch + role choice on top, architecture below.
  const home = <div className={aqua.home}>
    <section className={aqua.homeTop} aria-label="Choose a role">
      <div className={aqua.homeIntro}>
        <span className={aqua.eyebrow}>Private strategies · self-custodial liquidity</span>
        <h1>Two Providers.<span>One maker balance.</span></h1>
        <p>Makers let private strategies compete inside one confidential capital mandate. The active strategy can change with the market while funds remain in the Maker wallet.</p>
      </div>
      <div className={aqua.roleChoices}>
        <article className={`${styles.card} ${aqua.roleCard}`}>
          <div className={styles.cardBg} aria-hidden="true" />
          <div className={aqua.roleBody}>
            <span className={aqua.roleNumber}>Strategy Provider</span>
            <h2>I provide strategy</h2>
            <ul><li>Start from six Aqua templates</li><li>Your logic stays private in the TEE</li><li>Earn a fee when Makers profit</li></ul>
          </div>
          <div className={aqua.roleAction}><Primary onClick={() => goTo('provider')}>Open Provider Studio</Primary></div>
        </article>
        <article className={`${styles.card} ${aqua.roleCard}`}>
          <div className={styles.cardBg} aria-hidden="true" />
          <div className={aqua.roleBody}>
            <span className={aqua.roleNumber}>Maker</span>
            <h2>I provide liquidity</h2>
            <ul><li>Earn with a Provider&apos;s strategy</li><li>Funds stay in your own wallet</li><li>Pay a fee only on profit</li></ul>
          </div>
          <div className={aqua.roleAction}><Primary onClick={() => goTo('maker')}>Explore strategies</Primary></div>
        </article>
      </div>
    </section>
    <section className={aqua.architecture} aria-labelledby="architecture-title">
      <div className={aqua.architectureHeading}>
        <span className={aqua.eyebrow}>How it works</span>
        <h2 id="architecture-title">Private inputs meet inside the TEE.</h2>
        <p>The strategy logic stays hidden. The Maker keeps custody of funds.</p>
      </div>
      <div className={aqua.architectureDiagram}>
        <div className={`${aqua.archNode} ${aqua.providerNode}`}>
          <span className={aqua.archStep}>Strategy Provider</span>
          <strong>Private maker logic</strong>
          <small>Signals · pricing rules · adjustment thresholds</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.providerConnector}`} aria-hidden="true"><span>encrypted</span></div>
        <div className={`${aqua.archNode} ${aqua.makerNode}`}>
          <span className={aqua.archStep}>Maker</span>
          <strong>Private risk boundaries</strong>
          <small>Capital limit · inventory exposure · allowed assets</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.makerConnector}`} aria-hidden="true"><span>encrypted</span></div>
        <div className={`${aqua.archNode} ${aqua.teeNode}`}>
          <span className={aqua.archStep}>Chainlink TEE</span>
          <strong>Evaluate compatibility</strong>
          <small>Combine constraints · reject conflicts · produce intent</small>
        </div>
        <div className={`${aqua.archConnector} ${aqua.outputConnector}`} aria-hidden="true"><span>approved intent</span></div>
        <div className={`${aqua.archNode} ${aqua.aquaNode}`}>
          <span className={aqua.archStep}>1inch Aqua / SwapVM</span>
          <strong>Execute maker strategy</strong>
          <small>Uses authorized virtual balances from the Maker wallet</small>
        </div>
      </div>
      <p className={aqua.custodyNote}><strong>Funds path:</strong> Maker wallet → Aqua settlement. Funds never enter the TEE.</p>
    </section>
  </div>;

  return (
    <div ref={pageRef} className={`${styles.page} ${aqua.page}`}>
      <SiteHeader role={screen === 'home' ? null : screen} showRoles={screen !== 'home'} onReselect={() => goTo(screen)} />
      <main className={styles.mainScroll}>
        <div className={`${styles.main} ${screen === 'home' ? aqua.mainHome : ''}`}>
          {screen === 'home' ? home
            : screen === 'provider' ? <ProviderFlow key={restart} scrollTop={scrollTop} />
            : <MakerFlow key={restart} scrollTop={scrollTop} />}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
