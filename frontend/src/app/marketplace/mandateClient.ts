export type MarketRegime = 'normal' | 'high-volatility';
export type StrategySlot = 'A' | 'B';

export type StrategyDecision = {
  slot: StrategySlot;
  listingId: string;
  strategyHash: `0x${string}`;
  allowed: boolean;
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

export type MandateEvaluation = {
  mandateId: string;
  regime: MarketRegime;
  activeSlot: StrategySlot;
  decisions: [StrategyDecision, StrategyDecision];
  evidence: ChainEvidence;
};

export type SwapEvidence = {
  status: 'settled' | 'blocked';
  slot: StrategySlot;
  transactionHash: `0x${string}`;
  explorerUrl: string;
  tokenIn: 'WETH' | 'USDC';
  tokenOut: 'WETH' | 'USDC';
  makerWethDeltaAtomic: string;
  makerUsdcDeltaAtomic: string;
  revertReason?: string;
};

export type EvaluateMandateInput = {
  maker: string;
  providerStrategies: Array<{ slot: StrategySlot; listingId: string }>;
  policy: {
    capitalBudgetUsdc: string;
    maxWethExposurePct: string;
    maxWethInventoryUsdc: string;
    maxSwapUsdc: string;
    validityMinutes: string;
  };
};

const API_BASE = process.env.NEXT_PUBLIC_MANDATE_API_URL?.replace(/\/$/, '');

function getApiBase(): string {
  if (!API_BASE) {
    throw new Error('Mandate service is not configured. Set NEXT_PUBLIC_MANDATE_API_URL.');
  }
  return API_BASE;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(body?.message || `Request failed with status ${response.status}.`);
  if (!body) throw new Error('The mandate service returned an empty response.');
  return body as T;
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
}

function validateEvaluation(value: MandateEvaluation): MandateEvaluation {
  const slots = Array.isArray(value.decisions) ? value.decisions.map(item => item?.slot).sort().join('') : '';
  const allowed = Array.isArray(value.decisions) ? value.decisions.filter(item => item?.allowed) : [];
  if (!value.mandateId || !['normal', 'high-volatility'].includes(value.regime)
    || !['A', 'B'].includes(value.activeSlot) || slots !== 'AB' || allowed.length !== 1
    || allowed[0].slot !== value.activeSlot || !value.decisions.every(item => isHex(item.strategyHash))
    || !value.evidence || !isHex(value.evidence.reportDigest)
    || !isHex(value.evidence.reportTransactionHash) || !value.evidence.reportExplorerUrl
    || !value.evidence.networkName || !value.evidence.sequence || !value.evidence.expiresAt) {
    throw new Error('The mandate service returned incomplete or inconsistent onchain evidence.');
  }
  return value;
}

function validateSwap(value: SwapEvidence, requestedSlot: StrategySlot): SwapEvidence {
  if (!['settled', 'blocked'].includes(value.status) || value.slot !== requestedSlot
    || !isHex(value.transactionHash) || !value.explorerUrl
    || !['WETH', 'USDC'].includes(value.tokenIn) || !['WETH', 'USDC'].includes(value.tokenOut)
    || value.tokenIn === value.tokenOut || typeof value.makerWethDeltaAtomic !== 'string'
    || typeof value.makerUsdcDeltaAtomic !== 'string') {
    throw new Error('The mandate service returned incomplete swap evidence.');
  }
  return value;
}

export async function evaluateMandate(input: EvaluateMandateInput): Promise<MandateEvaluation> {
  return validateEvaluation(await request('/v1/mandates/evaluate', { method: 'POST', body: JSON.stringify(input) }));
}

export async function transitionMandate(mandateId: string): Promise<MandateEvaluation> {
  return request<MandateEvaluation>(`/v1/mandates/${encodeURIComponent(mandateId)}/transition`, { method: 'POST' }).then(validateEvaluation);
}

export async function executeStrategySwap(mandateId: string, slot: StrategySlot): Promise<SwapEvidence> {
  const result = await request<SwapEvidence>(`/v1/mandates/${encodeURIComponent(mandateId)}/swaps`, {
    method: 'POST',
    body: JSON.stringify({ slot }),
  });
  return validateSwap(result, slot);
}
