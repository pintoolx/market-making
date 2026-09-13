import type { ConfidentialEnvelope } from './confidentialEnvelope';
import type { EnsSelection } from '../../../../shared/ens/schema.mjs';

export type MarketRegime = 'normal' | 'high-volatility' | 'unknown';
export type StrategyStatus = 'active' | 'standby' | 'paused';

export type MandateStrategy = {
  listingId: string;
  name: string;
  provider?: string;
  strategyHash: `0x${string}`;
  status: StrategyStatus;
  maxAmountPerSwapAtomic: string;
  readiness?: { phase: 'unverified' | 'not-ready' | 'ready-for-quote'; authorized?: boolean; shipped?: boolean; funded?: boolean; programValid?: boolean; reasons: string[]; blockNumber?: string; checkedAt?: string; validUntil?: string };
};

export type ChainEvidence = {
  chainId: number;
  networkName: string;
  reportDigest: `0x${string}`;
  reportTransactionHash: `0x${string}`;
  reportExplorerUrl: string;
  sequence: string;
  expiresAt: string | null;
};

export type MandateEvent = {
  id: string;
  type: 'authorization-unchanged' | 'report-accepted' | 'strategy-activated' | 'swap-settled' | 'swap-rejected';
  title: string;
  detail: string;
  occurredAt: string;
  transactionHash?: `0x${string}`;
  explorerUrl?: string;
};

export type MandateState = {
  ensSelections?: (EnsSelection & { verifiedBlock: string; verifiedBlockHash: string })[];
  mandateId: string;
  maker: string;
  regime: MarketRegime;
  strategies: MandateStrategy[];
  evidence: ChainEvidence;
  events: MandateEvent[];
};

export type EvaluateMandateInput = {
  ensSelections?: EnsSelection[];
  maker: string;
  providerStrategyIds: string[];
  makerLimitsEnvelope: ConfidentialEnvelope;
};

export type ExecutableStrategy = {
  shipTransaction?: `0x${string}`;
  maker?: string;
  id: string;
  name: string;
  provider: string;
  strategyHash: `0x${string}`;
};

export type ExecutableStrategyCatalog = {
  maker: string;
  strategies: ExecutableStrategy[];
};

const PRODUCTION_API = 'https://mandate-service-production.up.railway.app';
const RETIRED_API = 'https://pintool-backend-production.up.railway.app';
const configuredApi = process.env.NEXT_PUBLIC_MANDATE_API_URL?.replace(/\/$/, '');
const API_BASE = !configuredApi || configuredApi === RETIRED_API ? PRODUCTION_API : configuredApi;

export function getApiBase(): string {
  if (!API_BASE) throw new Error('Mandate service is not configured. Set NEXT_PUBLIC_MANDATE_API_URL.');
  return API_BASE;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    || !value.evidence.networkName || !value.evidence.sequence
    || (value.evidence.expiresAt !== null && (typeof value.evidence.expiresAt !== 'string' || Number.isNaN(Date.parse(value.evidence.expiresAt))))
    || !Array.isArray(value.events)) {
    throw new Error('The mandate service returned incomplete or inconsistent onchain evidence.');
  }
  return value;
}

export async function createMandate(input: EvaluateMandateInput): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates', { method: 'POST', body: JSON.stringify(input) });
  return validateState(state);
}

export async function getExecutableStrategies(): Promise<ExecutableStrategyCatalog> {
  const value = await request<Partial<ExecutableStrategyCatalog>>('/v1/strategies');
  if (!/^0x[0-9a-f]{40}$/i.test(value.maker ?? '') || !Array.isArray(value.strategies)
    || !value.strategies.every(item => item?.id && item?.name && item?.provider && isHex(item.strategyHash))) {
    throw new Error('The mandate service returned an invalid strategy catalog.');
  }
  return value as ExecutableStrategyCatalog;
}

export async function getMandate(mandateId: string): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates/' + encodeURIComponent(mandateId));
  return validateState(state);
}

export async function reevaluateExecutionProfile(mandateId: string, providerStrategyId: string, ensSelection?: EnsSelection): Promise<MandateState> {
  const state = await request<MandateState>('/v1/mandates/' + encodeURIComponent(mandateId) + '/strategies', {
    method: 'POST', body: JSON.stringify({ providerStrategyId, ...(ensSelection ? { ensSelection } : {}) }),
  });
  return validateState(state);
}

export type MandateSummary = {
  mandateId: string;
  maker: string;
  strategies: { listingId: string; name: string }[];
  chainId: number;
  networkName: string;
  reportSequence: string;
  lastActivityAt: string | null;
};

export async function listMandates(maker: string): Promise<MandateSummary[]> {
  if (!/^0x[0-9a-f]{40}$/i.test(maker)) throw new Error('Maker address is invalid.');
  const value = await request<{ mandates: MandateSummary[] }>(`/v1/mandates?maker=${encodeURIComponent(maker)}`);
  if (!Array.isArray(value.mandates) || !value.mandates.every(item =>
    item && /^mandate-[A-Za-z0-9._-]+$/.test(item.mandateId) && item.maker?.toLowerCase() === maker.toLowerCase()
    && Number.isSafeInteger(item.chainId) && typeof item.networkName === 'string'
    && /^[1-9][0-9]*$/.test(item.reportSequence) && Array.isArray(item.strategies) && item.strategies.length > 0
    && item.strategies.every(strategy => typeof strategy.listingId === 'string' && typeof strategy.name === 'string')
    && (item.lastActivityAt === null || (typeof item.lastActivityAt === 'string' && Number.isFinite(Date.parse(item.lastActivityAt)))))) {
    throw new Error('The liquidity history could not be verified. Please retry.');
  }
  return value.mandates;
}
