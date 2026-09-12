'use client';

export type MandateReference = {
  maker: `0x${string}`;
  mandateId: string;
  updatedAt: number;
};

const KEY = 'pintool.market-making.mandates';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MANDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function readAll(): Record<string, MandateReference> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, item]) => {
      const reference = item as Partial<MandateReference>;
      return ADDRESS.test(reference.maker ?? '') && MANDATE_ID.test(reference.mandateId ?? '')
        && Number.isFinite(reference.updatedAt);
    })) as Record<string, MandateReference>;
  } catch {
    return {};
  }
}

export function readMandateReference(maker: string): MandateReference | null {
  if (!ADDRESS.test(maker)) return null;
  return readAll()[maker.toLowerCase()] ?? null;
}

export function saveMandateReference(maker: string, mandateId: string): void {
  if (!ADDRESS.test(maker) || !MANDATE_ID.test(mandateId)) throw new Error('Invalid mandate reference.');
  const normalized = maker.toLowerCase() as `0x${string}`;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      ...readAll(),
      [normalized]: { maker: normalized, mandateId, updatedAt: Date.now() },
    }));
  } catch {
    // The mandate remains recoverable from the service even if browser storage is unavailable.
  }
}
