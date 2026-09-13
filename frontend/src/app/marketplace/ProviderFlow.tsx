'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Secondary from '../components/shared/Secondary';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { PageHead } from './ui';
import ClmmPublisher from './ClmmPublisher';
import TemplateDraftEditor from './TemplateDraftEditor';
import aqua from './aqua.module.css';
import styles from './page.module.css';
import catalog from './catalog.module.css';

function StudioCard({ label, title, description, action, onSelect }: { label: string; title: string; description: string; action: string; onSelect(): void }) {
  return <article className={`${styles.card} ${aqua.card}`}>
    <div className={styles.cardBg} aria-hidden="true" />
    <div className={styles.cardBody}>
      <div className={styles.tagRow}><span className={`${styles.tag} ${aqua.chip}`}>{label}</span></div>
      <h3 className={styles.cardTitle}>{title}</h3>
      <p className={aqua.summary}>{description}</p>
    </div>
    <div className={`${styles.cardActions} ${catalog.cardActions}`}>
      <Secondary fullWidth onClick={onSelect}>{action}</Secondary>
    </div>
  </article>;
}

export default function ProviderFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const router = useRouter();
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
    <PageHead eyebrow="Provider Studio" title="Start with your strategy.">
      Customize a template or design your own with the strategy assistant.
    </PageHead>
    <div className={aqua.sectionTop}>
      <h2 className={aqua.sectionTitle}>Choose a starting point</h2>
      <span className={aqua.muted}>{AQUA_TEMPLATES.length + 1} options</span>
    </div>
    <div className={catalog.grid}>
      {AQUA_TEMPLATES.map(t => <StudioCard key={t.id} label={t.label} title={t.name} description={t.summary} action="Customize template" onSelect={() => open(t.id)} />)}
      <StudioCard label="Strategy Builder" title="Build your own"
        description="Describe your goals, compare supported curves and refine your strategy with the assistant."
        action="Open Strategy Builder" onSelect={() => router.push('/builder')} />
    </div>
  </section>;
}
