'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Primary from '../components/shared/Primary';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES, CATEGORY_LABELS } from './aquaTemplates';
import { PageHead } from './ui';
import ClmmPublisher from './ClmmPublisher';
import TemplateDraftEditor from './TemplateDraftEditor';
import aqua from './aqua.module.css';
import styles from './page.module.css';

export default function ProviderFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('edit');
    if (AQUA_TEMPLATES.some(t => t.id === requested)) setEditing(requested);
  }, []);
  const open = (id: string | null) => {
    setEditing(id);
    window.history.replaceState(null, '', id ? `/studio?edit=${id}` : '/studio');
    scrollTop();
  };
  const template = AQUA_TEMPLATES.find(t => t.id === editing);
  if (template?.id === 'clmm') return <ClmmPublisher onBack={() => open(null)} />;
  if (template) {
    if (!account.ready) return <p role="status">Loading your workspace…</p>;
    const owner = account.address?.toLowerCase() ?? account.userId ?? 'guest';
    return <TemplateDraftEditor key={`${owner}:${template.id}`} template={template} owner={owner} onBack={() => open(null)} />;
  }
  return <section className={aqua.flow}>
    <PageHead eyebrow="Provider Studio" title="Start with a strategy template.">
      Choose a starting point, shape its parameters and make it your own.
    </PageHead>
    {process.env.NEXT_PUBLIC_BUILDER_ENABLED === 'true' && <p><Link href="/builder">Design with the strategy assistant →</Link></p>}
    {(['Base strategy', 'Strategy modifier', 'Capital policy'] as const).map(category => <section key={category} className={aqua.flow} aria-label={CATEGORY_LABELS[category]}>
      <h2 className={aqua.sectionTitle}>{CATEGORY_LABELS[category]}</h2>
      <div className={`${styles.grid} ${aqua.grid}`}>
        {AQUA_TEMPLATES.filter(t => t.category === category).map(t => <article key={t.id} className={aqua.panel}>
          <span className={aqua.eyebrow}>{t.label}</span><h3>{t.name}</h3><p>{t.summary}</p>
          <Primary onClick={() => open(t.id)}>Customize template</Primary>
        </article>)}
      </div>
    </section>)}
  </section>;
}
