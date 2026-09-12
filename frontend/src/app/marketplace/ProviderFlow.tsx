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

const PUBLISHABLE_TEMPLATES = AQUA_TEMPLATES.filter(template => LP_CAPABILITIES[template.id]?.publication);

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
      Publish a version of your CLMM strategy for Makers to review. CLMM is currently the available template.
    </PageHead>
    <p><Link href="/ens">Manage your ENS strategy names and publishers →</Link></p>
    {process.env.NEXT_PUBLIC_BUILDER_ENABLED === 'true' && <p><Link href="/builder">透過對話設計你的策略 →</Link></p>}
    <div className={`${styles.grid} ${aqua.grid}`}>
      {PUBLISHABLE_TEMPLATES.map(template => <article key={template.id} className={aqua.panel}>
          <span className={aqua.eyebrow}>{template.label}</span>
          <h2>{template.name}</h2><p>{template.summary}</p>
          <p className={aqua.muted}>Set your price range and trading limits, then sign a version to publish it.</p>
          <Primary onClick={() => { setEditing(true); scrollTop(); }}>Open CLMM editor</Primary>
        </article>)}
    </div>
    <p className={aqua.muted}>Publishing makes a strategy available for review. Makers complete activation before it can quote trades.</p>
  </section>;
}
