'use client';

import { useCallback, useEffect, useState } from 'react';
import { AQUA_TEMPLATES, type AquaTemplate } from './aquaTemplates';

// A strategy a Maker can pick: either one the Provider published from /studio or a sample listing.
// feePct: share of the Maker's profit paid to the Provider, only when there is a profit.
export type Listing = { id: string; name: string; summary: string; template: AquaTemplate; mine: boolean; provider?: string; providerAvatar?: string; feePct?: number; publishedAt?: number; executionReady?: boolean };
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
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CHANGED));
}

export function usePublishedListings() {
  const [published, setPublished] = useState<Listing[]>([]);

  // Read after mount so server and first client render match; stay in sync with other components and tabs.
  useEffect(() => {
    const sync = () => setPublished(toListings(readStored()));
    sync();
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(CHANGED, sync); window.removeEventListener('storage', sync); };
  }, []);

  const publish = useCallback((template: AquaTemplate, name: string, summary: string, provider: string | undefined, feePct: number, providerAvatar?: string) => {
    write([{ templateId: template.id, name, summary, provider, providerAvatar: providerAvatar || undefined, feePct, publishedAt: Date.now() }, ...readStored().filter(item => item.templateId !== template.id)]);
  }, []);

  const unpublish = useCallback((templateId: string) => {
    write(readStored().filter(item => item.templateId !== templateId));
  }, []);

  return { published, publish, unpublish };
}
