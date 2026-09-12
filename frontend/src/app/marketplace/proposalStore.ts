'use client';

import { useCallback, useEffect, useState } from 'react';

// Local index of mandates accepted by the configured mandate service, used by the current Profile screen.
export type Proposal = { id: string; strategyName: string; mechanism: string; budget: string; maxExposure: string; maxWeakAsset: string; maxTrade: string; validityMinutes?: string; authorization?: 'until-changed'; feePct?: number; createdAt: number };

const KEY = 'pintool.aqua.proposals';
const CHANGED = 'pintool:proposals-changed';

export function readProposals(): Proposal[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Proposal[]; } catch { return []; }
}

function write(proposals: Proposal[]) {
  try { localStorage.setItem(KEY, JSON.stringify(proposals)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CHANGED));
}

export function useProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);

  useEffect(() => {
    const sync = () => setProposals(readProposals());
    sync();
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(CHANGED, sync); window.removeEventListener('storage', sync); };
  }, []);

  // One proposal per strategy: saving again replaces the earlier one.
  const save = useCallback((proposal: Omit<Proposal, 'createdAt'>) => {
    write([{ ...proposal, createdAt: Date.now() }, ...readProposals().filter(item => item.id !== proposal.id)]);
  }, []);

  const remove = useCallback((id: string) => write(readProposals().filter(item => item.id !== id)), []);

  return { proposals, save, remove };
}
