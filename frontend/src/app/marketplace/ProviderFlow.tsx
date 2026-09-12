'use client';

import { useEffect, useState } from 'react';
import Primary from '../components/shared/Primary';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { PageHead } from './ui';
import ClmmPublisher from './ClmmPublisher';
import { LP_CAPABILITIES } from '../../../../shared/lp-release.mjs';
import aqua from './aqua.module.css';
import styles from './page.module.css';
import Link from 'next/link';

export default function ProviderFlow({ scrollTop }: { scrollTop: () => void }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('edit') === 'clmm') {
      setEditing(true);
      window.history.replaceState(null, '', '/studio');
    }
  }, []);
  if (editing) return <ClmmPublisher onBack={() => { setEditing(false); scrollTop(); }} />;
  return <section className={aqua.flow}>
    <PageHead eyebrow="Provider Studio" title="Choose an LP template.">
      CLMM supports signed, versioned publication. A Maker-specific program and a valid Guard report are required before a strategy can quote.
    </PageHead>
    <p><Link href="/ens">Manage your ENS strategy names and publishers →</Link></p>
    <div className={`${styles.grid} ${aqua.grid}`}>
      {AQUA_TEMPLATES.map(template => {
        const capability = LP_CAPABILITIES[template.id];
        return <article key={template.id} className={aqua.panel}>
          <span className={aqua.eyebrow}>{template.label}</span>
          <h2>{template.name}</h2><p>{template.summary}</p>
          <p className={aqua.muted}>{capability.publication ? 'Single range, asymmetric bounds, zero swap fee, fixed 30-minute volatility signal. New publications require Maker provisioning.' : capability.reason}</p>
          <Primary disabled={!capability.publication} onClick={() => { setEditing(true); scrollTop(); }}>{capability.publication ? 'Open CLMM editor' : 'Publication pending'}</Primary>
        </article>;
      })}
    </div>
    <p className={aqua.muted}>Revenue sharing, automatic inventory conversion and simultaneous multi-strategy authorization are not enabled. Existing legacy listings are browser previews; this editor does not submit their saved parameters.</p>
  </section>;
}
