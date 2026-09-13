'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormInput from '../components/shared/FormInput';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import { useAccount } from '../providers/useAccount';
import { AQUA_TEMPLATES } from './aquaTemplates';
import { ListingGrid, PageHead, Steps, StrategyCardShell } from './ui';
import ClmmPublisher from './ClmmPublisher';
import TemplateDraftEditor from './TemplateDraftEditor';
import aqua from './aqua.module.css';
import styles from './page.module.css';

const CATEGORIES = ['All', 'Base strategy', 'Strategy modifier', 'Capital policy'] as const;
const STEPS = ['Choose a template', 'Configure strategy', 'Publish a version'];

function StudioCard({ mechanism, category, title, description, privateInputs, action, onSelect }: {
  mechanism: string;
  category: string;
  title: string;
  description: string;
  privateInputs: string;
  action: string;
  onSelect(): void;
}) {
  const tags = <>
    <span className={`${styles.tag} ${aqua.chip}`}>{mechanism}</span>
    <span className={`${styles.tag} ${aqua.chip}`}>{category}</span>
  </>;

  return <StrategyCardShell tags={tags} title={title} action={<Primary onClick={onSelect}>{action}</Primary>}>
    <p className={aqua.summary}>{description}</p>
    <div className={aqua.cardRule}>
      <span className={aqua.eyebrow}>Confidential inputs</span>
      <p>{privateInputs}</p>
    </div>
  </StrategyCardShell>;
}

export default function ProviderFlow({ scrollTop }: { scrollTop: () => void }) {
  const account = useAccount();
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All');
  const editing = params.get('edit');
  const open = (id: string | null) => {
    router.push(id ? `/studio?edit=${encodeURIComponent(id)}` : '/studio');
    scrollTop();
  };
  const template = AQUA_TEMPLATES.find(t => t.id === editing);
  if (template?.id === 'clmm') return <ClmmPublisher onBack={() => open(null)} />;
  if (template) {
    if (!account.ready) return <p role="status">Loading your workspace…</p>;
    const owner = account.address?.toLowerCase() ?? account.userId ?? 'guest';
    return <TemplateDraftEditor key={`${owner}:${template.id}`} template={template} owner={owner} onBack={() => open(null)} />;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visible = AQUA_TEMPLATES.filter(item =>
    (category === 'All' || item.category === category)
    && `${item.name} ${item.mechanism} ${item.category} ${item.summary} ${item.privateInputs}`.toLowerCase().includes(normalizedQuery),
  );
  const builderMatches = category === 'All'
    && `build your own custom strategy builder compose mechanisms parameters private logic`.includes(normalizedQuery);
  const optionCount = visible.length + (builderMatches ? 1 : 0);

  return <section className={aqua.flow}>
    <PageHead eyebrow="Strategy Studio" title="Choose a market-making model.">
      Each template defines how swaps are priced. You set its public parameters and confidential execution rules.
    </PageHead>
    <Steps steps={STEPS} current={0} />
    <div className={aqua.search}>
      <FormInput
        fullWidth
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search templates"
        aria-label="Search templates"
      />
      <div className={aqua.filters} aria-label="Template categories">
        {CATEGORIES.map(item => <Secondary key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</Secondary>)}
      </div>
    </div>
    <div className={aqua.sectionTop}>
      <h2 className={aqua.sectionTitle}>Strategy templates</h2>
      <span className={aqua.muted} role="status">{optionCount} {optionCount === 1 ? 'option' : 'options'}</span>
    </div>
    <ListingGrid>
      {visible.map(template => <StudioCard
        key={template.id}
        mechanism={template.mechanism}
        category={template.category}
        title={template.name}
        description={template.summary}
        privateInputs={template.privateInputs}
        action="Customize template"
        onSelect={() => open(template.id)}
      />)}
      {builderMatches && <StudioCard
        mechanism="Custom"
        category="Strategy builder"
        title="Build your own"
        description="Build a market-making strategy by combining supported models, limits and conditions."
        privateInputs="The models, parameters and confidential rules that shape your strategy."
        action="Open strategy builder"
        onSelect={() => router.push('/builder')}
      />}
    </ListingGrid>
    {optionCount === 0 && <div className={aqua.empty}>
      <h3>No matching templates</h3>
      <p>Try another name or clear the filters.</p>
      <Secondary onClick={() => { setQuery(''); setCategory('All'); }}>Clear filters</Secondary>
    </div>}
  </section>;
}
