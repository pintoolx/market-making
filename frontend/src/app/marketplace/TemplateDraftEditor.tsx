'use client';

import { useEffect, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import type { AquaTemplate } from './aquaTemplates';
import aqua from './aqua.module.css';

type Field = { key: string; label: string; value: string; min?: string; max?: string; step?: string; options?: string[] };
const fields: Record<string, Field[]> = {
  xyc: [
    { key: 'pair', label: 'Token pair', value: 'WETH / USDC' },
    { key: 'fee', label: 'Swap fee (%)', value: '0.3', min: '0', max: '100', step: '0.01' },
    { key: 'fill', label: 'Maximum quote tokens per trade', value: '1', min: '0.000001', step: 'any' },
  ],
  pegged: [
    { key: 'pair', label: 'Token pair', value: 'USDC / DAI' },
    { key: 'reference', label: 'Reference price (quote per base token)', value: '1', min: '0.00000001', step: 'any' },
    { key: 'spread', label: 'Quoted spread (%)', value: '0.05', min: '0', max: '100', step: '0.01' },
  ],
  decay: [
    { key: 'base', label: 'Base strategy', value: 'Constant product', options: ['Constant product', 'Price range', 'Stable pair'] },
    { key: 'adjustment', label: 'Initial price adjustment (%)', value: '0.1', min: '0', max: '100', step: '0.01' },
    { key: 'period', label: 'Decay period (seconds)', value: '60', min: '1', step: '1' },
  ],
  inventory: [
    { key: 'base', label: 'Base strategy', value: 'Price range', options: ['Constant product', 'Price range', 'Stable pair'] },
    { key: 'pair', label: 'Token pair', value: 'WETH / USDC' },
    { key: 'baseCap', label: 'Public base-token inventory ceiling', value: '0.01', min: '0.00000001', step: 'any' },
    { key: 'quoteCap', label: 'Public quote-token inventory ceiling', value: '20', min: '0.000001', step: 'any' },
  ],
  shared: [
    { key: 'pair', label: 'Supported token pair', value: 'WETH / USDC' },
    { key: 'strategies', label: 'Maximum concurrent strategies', value: '2', min: '1', max: '100', step: '1' },
    { key: 'quoteCap', label: 'Public quote-token ceiling per strategy', value: '20', min: '0.000001', step: 'any' },
  ],
};

// Design drafts contain public parameters only. They are never Provider releases or executable programs.
export default function TemplateDraftEditor({ template, owner, onBack }: { template: AquaTemplate; owner: string; onBack(): void }) {
  const definition = fields[template.id] ?? [];
  const storageKey = `pintool:template-design:v1:${owner}:${template.id}`;
  const [name, setName] = useState(template.name), [description, setDescription] = useState(template.summary);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(definition.map(f => [f.key, f.value])));
  const [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.schema !== 1 || draft.templateId !== template.id || typeof draft.name !== 'string' || typeof draft.description !== 'string' || !draft.values) throw new Error('invalid draft');
        const restored = Object.fromEntries(definition.map(field => {
          const value = draft.values[field.key];
          if (typeof value !== 'string' || value.length > 120 || (field.options && !field.options.includes(value))) throw new Error('invalid field');
          return [field.key, value];
        }));
        setName(draft.name.slice(0, 80)); setDescription(draft.description.slice(0, 600)); setValues(restored); setSaved(true);
      }
    } catch { setError('The saved design could not be loaded. Review these values before saving a replacement.'); }
    setLoaded(true);
    // Parent keys the editor by owner and template, so identities never share form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const changed = () => { setSaved(false); setError(''); };
  const save = () => {
    try {
      if (!name.trim() || !description.trim() || definition.some(f => !values[f.key]?.trim())) throw new Error('Complete the public design fields first.');
      localStorage.setItem(storageKey, JSON.stringify({ schema: 1, templateId: template.id, name: name.trim(), description: description.trim(), values }));
      setSaved(true); setError('');
    } catch (reason) { setError(reason instanceof Error && reason.message === 'Complete the public design fields first.' ? reason.message : 'Your design could not be saved in this browser. Keep this page open and try again.'); }
  };
  return <section className={aqua.flow}>
    <button className={aqua.backLink} onClick={onBack}>← All templates</button>
    <div><span className={aqua.eyebrow}>{template.label}</span><h1>{template.name}</h1><p>{template.summary}</p></div>
    <form className={aqua.panel} onSubmit={e => { e.preventDefault(); save(); }}>
      <fieldset disabled={!loaded}>
        <legend>Public design</legend>
        <label>Strategy name<FormInput required maxLength={80} value={name} onChange={e => { setName(e.target.value); changed(); }} /></label>
        <label>Description<textarea required maxLength={600} value={description} onChange={e => { setDescription(e.target.value); changed(); }} /></label>
        <div className={aqua.structuredFields}>{definition.map(field => <label key={field.key}>{field.label}
          {field.options ? <select value={values[field.key]} onChange={e => { setValues(v => ({ ...v, [field.key]: e.target.value })); changed(); }}>{field.options.map(option => <option key={option}>{option}</option>)}</select>
            : <FormInput required type={field.min !== undefined ? 'number' : 'text'} min={field.min} max={field.max} step={field.step} maxLength={120} value={values[field.key]} onChange={e => { setValues(v => ({ ...v, [field.key]: e.target.value })); changed(); }} />}
        </label>)}</div>
      </fieldset>
      <p className={aqua.hint}>Only public design parameters are saved in this browser. Keep private signals and risk rules out of this draft.</p>
      <div className={aqua.actionRow}><Primary type="submit" disabled={!loaded}>Save draft</Primary><Secondary type="button" onClick={onBack}>All templates</Secondary></div>
      {saved && <p role="status">Draft saved in this browser.</p>}
      {error && <p role="alert" className={aqua.fieldError}>{error}</p>}
      <p className={aqua.muted}>You can keep editing this design. Onchain publication for this template is not available yet.</p>
    </form>
  </section>;
}
