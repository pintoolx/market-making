import type { ConfidentialEnvelope } from './confidentialEnvelope';

export type MarketRegime = 'normal' | 'high-volatility' | 'unknown';
export type StrategyStatus = 'active' | 'standby' | 'paused';

export type MandateStrategy = {
  listingId: string;
  name: string;
  provider?: string;
  strategyHash: `0x${string}`;
  status: StrategyStatus;
  maxAmountPerSwapAtomic: string;
};

export type ChainEvidence = {
  chainId: number;
  networkName: string;
  reportDigest: `0x${string}`;
  reportTransactionHash: `0x${string}`;
  reportExplorerUrl: string;
  sequence: string;
  expiresAt: string;
};

export type MandateEvent = {
  id: string;
  type: 'report-accepted' | 'strategy-activated' | 'swap-settled' | 'swap-rejected';
  title: string;
  detail: string;
  occurredAt: string;
  transactionHash?: `0x${string}`;
  explorerUrl?: string;
};

export type MandateState = {
  mandateId: string;
  maker: string;
  regime: MarketRegime;
  strategies: MandateStrategy[];
  evidence: ChainEvidence;
  events: MandateEvent[];
};

export type EvaluateMandateInput = {
  maker: string;
  providerStrategyIds: string[];
  makerLimitsEnvelope: ConfidentialEnvelope;
};

const API_BASE = process.env.NEXT_PUBLIC_MANDATE_API_URL?.replace(/\/$/, '');

function getApiBase(): string {
  if (!API_BASE) throw new Error('Mandate service is not configured. Set NEXT_PUBLIC_MANDATE_API_URL.');
  return API_BASE;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(getApiBase() + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(body?.message || 'Request failed with status ' + response.status + '.');
  if (!body) throw new Error('The mandate service returned an empty response.');
  return body as T;
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
}

function validateState(value: MandateState): MandateState {
  const active = Array.isArray(value.strategies) ? value.strategies.filter(item => item?.status === 'active') : [];
  if (!value.mandateId || !/^0x[0-9a-f]{40}$/i.test(value.maker) || !['normal', 'high-volatility', 'unknown'].includes(value.regime)
    || !Array.isArray(value.strategies) || value.strategies.length === 0 || active.length > 1
    || !value.strategies.every(item => item?.listingId && item?.name && isHex(item.strategyHash))
    || !value.evidence || !isHex(value.evidence.reportDigest)
    || !isHex(value.evidence.reportTransactionHash) || !value.evidence.reportExplorerUrl
    || !value.evidence.networkName || !value.evidence.sequence || !value.evidence.expiresAt
    || !Array.isArray(value.events)) {
    throw new Error('The mandate service returned incomplete or inconsistent onchain evidence.');
  }
  return value;
}

export async function createMandate(input: EvaluateMandateInput): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates', { method: 'POST', body: JSON.stringify(input) });
  return validateState(state);
}

export async function getMandate(mandateId: string): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates/' + encodeURIComponent(mandateId));
  return validateState(state);
}

export async function addMandateStrategy(mandateId: string, providerStrategyId: string): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates/' + encodeURIComponent(mandateId) + '/strategies', {
    method: 'POST', body: JSON.stringify({ providerStrategyId }),
  });
  return validateState(state);
}
