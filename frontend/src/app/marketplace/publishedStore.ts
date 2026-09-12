'use client';

import { useCallback, useEffect, useState } from 'react';
import { AQUA_TEMPLATES, type AquaTemplate } from './aquaTemplates';
import { request } from './mandateClient';
import { useAccount } from '../providers/useAccount';
import type { PublicRelease } from './ClmmPublisher';
import type { EnsSelection } from '../../../../shared/ens/schema.mjs';

// A strategy a Maker can pick: either one the Provider published from /studio or a sample listing.
// feePct: share of the Maker's profit paid to the Provider, only when there is a profit.
export type Listing = { id: string; name: string; summary: string; template: AquaTemplate; mine: boolean; provider?: string; providerAvatar?: string; feePct?: number; publishedAt?: number; executionReady?: boolean; version?: number; releaseId?: string; executionProfileIds?: string[]; ensSelection?: EnsSelection };
type Stored = { templateId: string; name: string; summary: string; provider?: string; providerAvatar?: string; feePct?: number; publishedAt?: number };

// Kept in this browser until the TEE / backend stores Provider strategies. Private logic is never stored here.
const KEY = 'pintool.aqua.published';
const CHANGED = 'pintool:published-changed';

function readStored(): Stored[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Stored[]; } catch { return []; }
}

function toListings(stored: Stored[]): Listing[] {
  return stored.flatMap(item => {
    const template = AQUA_TEMPLATES.find(t => t.id === item.templateId);
    return template ? [{ id: `mine-${template.id}`, name: item.name, summary: item.summary, template, mine: true, provider: item.provider, providerAvatar: item.providerAvatar, feePct: item.feePct, publishedAt: item.publishedAt }] : [];
  });
}

export const readPublished = () => toListings(readStored());

function write(stored: Stored[]) {
  localStorage.setItem(KEY, JSON.stringify(stored));
  window.dispatchEvent(new Event(CHANGED));
}

export function usePublishedListings() {
  const [published, setPublished] = useState<Listing[]>([]);
  const account = useAccount();

  // Read after mount so server and first client render match; stay in sync with other components and tabs.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const legacy = toListings(readStored());
      try {
        const data = await request<{ strategies: PublicRelease[] }>('/v1/provider-strategies');
        const template = AQUA_TEMPLATES.find(t => t.id === 'clmm')!;
        const remote = data.strategies.filter(r => r.state === 'published').map(r => ({
          id: `${r.id}.v${r.version}`, releaseId: r.id, version: r.version, name: r.name, summary: r.summary,
          template, provider: r.provider, mine: r.provider === account.address?.toLowerCase(), feePct: 0,
        }));
        if (alive) setPublished([...remote, ...legacy]);
      } catch { if (alive) setPublished(legacy); }
    };
    void sync();
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { alive = false; window.removeEventListener(CHANGED, sync); window.removeEventListener('storage', sync); };
  }, [account.address]);

  const publish = useCallback((template: AquaTemplate, name: string, summary: string, provider: string | undefined, feePct: number, providerAvatar?: string) => {
    write([{ templateId: template.id, name, summary, provider, providerAvatar: providerAvatar || undefined, feePct, publishedAt: Date.now() }, ...readStored().filter(item => item.templateId !== template.id)]);
  }, []);

  const unpublish = useCallback((templateId: string) => {
    write(readStored().filter(item => item.templateId !== templateId));
  }, []);

  return { published, publish, unpublish };
}
