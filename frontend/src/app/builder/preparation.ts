import { canonical, contentDigest, decodeGuardedOrder, digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import type { Draft, Token } from './client';

// Public browser projections. No executor, worker, signer or provider transport is imported.
export type CompilationItem = { artifactId: string; revision: string; manifestHash: string; createdAt: string };
export type Compilation = { artifactId: string; mode: 'compiled-order'; current: boolean; registrationReady: false; createdAt: string;
  payload: { draftId: string; revision: number; contentDigest: string; manifestHash: string; specHash: string; recipeId: string;
    strategy: `0x${string}`; program: string; programHash: string; orderHash: string; strategyHash: string;
    decoded: ReturnType<typeof decodeGuardedOrder>; tokens: string[]; amounts: string[] } };
export type InventoryResult = { draftId: string; revision: number; contentDigest: string; knownArtifactsTruncated: boolean;
  requestedAllocations: Draft['allocations']; registrationReady: false;
  inventory: { mode: 'live-read' | 'fork-with-overrides' | 'mock'; maker: string; chainId: number; manifestHash: string;
    blockNumber: string; blockHash: string; blockTimestamp: string; observedAt: string; spender: string;
    native: { symbol: string; decimals: number; walletBalanceAtomic: string };
    tokens: (Token & { walletBalanceAtomic: string; allowanceToAquaAtomic: string })[];
    activeStrategyHash: string; commitmentsComplete: false; registrationReady: false;
    strategies: { strategyHash: string; state: 'shipped' | 'docked' | 'unregistered-for-pair' | 'inconsistent-pair'; source: 'owned-artifact' | 'guard-selection'; selectedByGuard: boolean;
      balances: { token: string; virtualBalanceAtomic: string; inventoryAndAllowanceCapacityAtomic: string }[] }[] } };
export type SimulationItem = { id: string; artifactId: string; revision: number; state: string; attempts: number; current: boolean;
  mode: 'mock' | 'fork-with-overrides' | null; passed: boolean | null; coverageComplete: boolean | null; caseCount: number; skippedCaseCount: number;
  issues: { name: string; passed: boolean | null; error?: string; guidance: string }[]; errorCode?: string; registrationReady: false };
export type SimulationDetail = { id: string; artifactId: string; draftId: string; revision: number; state: string; current: boolean; registrationReady: false;
  report: null | { mode: 'mock' | 'fork-with-overrides'; draftId: string; revision: number; passed: boolean; coverageComplete: boolean; registrationReady: false;
    cases: { name: string; passed: boolean | null; error?: string }[] } };

/** Public consistency check for this read-only view; wallet preparation still needs
 * the full deterministic curve comparison and fresh preflight on the server. */
export function verifyCompilation(value: Compilation, draft: Draft, expectedId = value.artifactId) {
  const p = value.payload, decoded = decodeGuardedOrder(p.strategy);
  if (value.artifactId !== expectedId || value.mode !== 'compiled-order' || value.registrationReady !== false || !value.current || draft.kind !== 'maker' ||
    p.draftId !== draft.id || p.revision !== draft.revision || p.contentDigest !== contentDigest(draft) || p.manifestHash !== digestJson(profile) ||
    p.specHash !== digestJson({ spec: draft.spec, maker: draft.maker, allocations: draft.allocations, salt: draft.salt }) ||
    decoded.maker !== draft.maker || decoded.guard !== profile.guard || decoded.kind !== draft.spec.model?.kind || decoded.deadline !== draft.spec.deadline ||
    decoded.salt !== draft.salt || decoded.baseToken !== draft.spec.baseToken?.address || decoded.quoteToken !== draft.spec.quoteToken?.address ||
    canonical(decoded.guardEnvelope) !== canonical(draft.spec.guardEnvelope) || canonical(decoded) !== canonical(p.decoded) ||
    canonical(p.tokens) !== canonical([decoded.baseToken, decoded.quoteToken]) ||
    canonical(p.amounts) !== canonical([draft.allocations?.baseAtomic, draft.allocations?.quoteAtomic]) ||
    p.program !== decoded.program || p.programHash !== decoded.programHash || p.orderHash !== decoded.orderHash || p.strategyHash !== decoded.strategyHash)
    throw new Error('preparation-result-mismatch');
  return value;
}

export function verifyInventory(value: InventoryResult, draft: Draft) {
  const s = value.inventory;
  if (draft.kind !== 'maker' || value.draftId !== draft.id || value.revision !== draft.revision || value.contentDigest !== contentDigest(draft) ||
    canonical(value.requestedAllocations ?? null) !== canonical(draft.allocations ?? null) || value.registrationReady !== false ||
    s.maker !== draft.maker || s.chainId !== profile.chainId || s.manifestHash !== digestJson(profile) || s.spender !== profile.aqua ||
    !['live-read', 'fork-with-overrides', 'mock'].includes(s.mode) || s.registrationReady !== false || s.commitmentsComplete !== false ||
    canonical(s.tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals }))) !== canonical(profile.tokens) ||
    !Number.isFinite(Date.parse(s.observedAt)) || !/^\d+$/.test(s.blockNumber) || !/^\d+$/.test(s.blockTimestamp) ||
    s.native.symbol !== 'ETH' || s.native.decimals !== 18) throw new Error('preparation-result-mismatch');
  const amounts = [s.native.walletBalanceAtomic, ...s.tokens.flatMap(t => [t.walletBalanceAtomic, t.allowanceToAquaAtomic]),
    ...s.strategies.flatMap(r => r.balances.flatMap(b => [b.virtualBalanceAtomic, b.inventoryAndAllowanceCapacityAtomic]))];
  if (s.strategies.length > 41 || amounts.some(a => !/^(0|[1-9]\d{0,77})$/.test(a) || BigInt(a) >= 1n << 256n) ||
    s.strategies.some(r => r.balances.length !== 2 || new Set(r.balances.map(b => b.token)).size !== 2 ||
      r.balances.some(b => !s.tokens.some(t => t.address === b.token)))) throw new Error('preparation-result-mismatch');
  return value;
}

export const evidenceLabel = (mode: string | null) => mode === 'live-read' ? 'Live Sepolia read' : mode === 'fork-with-overrides' ? 'Isolated fork · Synthetic funds and authorization' : mode === 'mock' ? 'Test data · No onchain verification' : 'Awaiting evaluation';
export const simulationState = (state: string) => ({ pending: 'Queued', running: 'Simulating', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' } as Record<string, string>)[state] ?? 'Unknown state';
