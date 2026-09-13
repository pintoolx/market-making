import { setTimeout as delay } from 'node:timers/promises';
import { zeroHash } from 'viem';
import { digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder';

/** Synthetic public data only. The fixture handler/worker is never mounted by the app. */
export async function fixtureInventory(maker, hashes) {
  return { schemaVersion: 1, engineVersion: 'builder-inventory-v1', mode: 'mock', chainId: profile.chainId,
    manifestHash: digestJson(profile), maker, blockNumber: '1', blockHash: zeroHash, blockTimestamp: String(Math.floor(Date.now() / 1000)),
    observedAt: new Date().toISOString(), finality: 'latest-unfinalized', contracts: [], sourceRuntimeRebuilt: false,
    native: { symbol: 'ETH', decimals: 18, walletBalanceAtomic: '1000000000000000000' }, spender: profile.aqua,
    tokens: profile.tokens.map(t => ({ ...t, walletBalanceAtomic: t.symbol === 'WETH' ? '20000000000000000' : '50000000', allowanceToAquaAtomic: '0' })),
    activeStrategyHash: zeroHash, strategies: hashes.map(strategyHash => ({ strategyHash, state: 'unregistered-for-pair', source: 'owned-artifact', selectedByGuard: false,
      balances: profile.tokens.map(t => ({ token: t.address, virtualBalanceAtomic: '0', tokensCount: 0, inventoryAndAllowanceCapacityAtomic: '0' })) })),
    commitmentsComplete: false, registrationReady: false, limitations: ['Synthetic fixture; no chain inventory was read.'] };
}
export const fixtureSimulationControl = { delayMs: 1000, skip: false };
export async function fixtureSimulation({ draft, compilation }, signal) {
  const control = { ...fixtureSimulationControl };
  await delay(control.delayMs, undefined, { signal });
  const tiny = BigInt(draft.allocations.baseAtomic) === 1n;
  const cases = [{ name: 'fixture-transfer', passed: !tiny, ...(tiny ? { error: 'UnsupportedSwap' } : {}) },
    { name: 'fixture-boundary', passed: control.skip ? null : true }];
  return { schemaVersion: 1, engineVersion: 'builder-lifecycle-v1', mode: 'mock', draftId: draft.id, revision: draft.revision,
    artifactDigest: digestJson(compilation), manifestHash: compilation.manifestHash, passed: cases.every(c => c.passed !== false),
    coverageComplete: cases.every(c => c.passed === true), registrationReady: false, cases };
}
