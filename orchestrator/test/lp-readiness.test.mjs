import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReadiness, readLpReadiness } from '../src/lp-readiness.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activationStore } from '../src/activation-store.mjs';

const hash = `0x${'1'.repeat(64)}`;
const base = () => ({ report: { schemaVersion: 1, nonce: 1n, allowedDirections: 3, validAfter: 99, validUntil: 200 }, activeHash: hash, strategyHash: hash,
  raw: [[10n, 2], [20n, 2]], wallets: [10n, 20n], allowances: [10n, 20n], now: 100, programDeadline: 300 });
test('only ship, current authorization, available funding and unexpired program together permit quoting', () => {
  assert.equal(assessReadiness(base()).phase, 'ready-for-quote');
  for (const changes of [
    { raw: [[0n, 0], [0n, 0]] }, { raw: [[0n, 255], [0n, 255]] }, { raw: [[0n, 2], [20n, 2]] },
    { allowances: [9n, 20n] }, { wallets: [10n, 19n] }, { now: 201 }, { now: 98 },
    { activeHash: `0x${'2'.repeat(64)}` }, { report: { ...base().report, allowedDirections: 0 } },
    { programDeadline: undefined }, { programDeadline: 99 },
  ]) assert.equal(assessReadiness({ ...base(), ...changes }).phase, 'not-ready');
});

test('RPC reads share one block and reject wrong-domain or stale data', async t => {
  const maker = '0x' + '2'.repeat(40), guard = '0x' + '3'.repeat(40), router = '0x' + '4'.repeat(40), aqua = '0x' + '5'.repeat(40);
  const config = { chainId: 11155111, guard, router, aqua, strategies: [{ id: 's', strategyHash: hash, programDeadline: 300 }] };
  const calls = [];
  const report = { ...base().report, chainId: 11155111n, guard, router, maker, strategyHash: hash,
    token0: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', token1: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' };
  const client = { getChainId: async () => 11155111, getBlock: async () => ({ number: 42n, timestamp: 100n }),
    readContract: async args => {
      calls.push(args);
      if (args.functionName === 'getReport') return [report, hash];
      if (args.functionName === 'activeStrategyHash') return hash;
      if (args.functionName === 'rawBalances') return [10n, 2];
      return 10n;
    } };
  const snapshot = await readLpReadiness(config, maker, { listingId: 's', strategyHash: hash }, { client, nowMs: () => 100000 });
  assert.equal(snapshot.phase, 'ready-for-quote');
  assert.equal(snapshot.validUntil, new Date(130000).toISOString());
  assert.equal(calls.length, 8); assert.ok(calls.every(c => c.blockNumber === 42n));
  // A wallet-confirmed release is not present in the environment's original catalog.
  const stateDir = await mkdtemp(join(tmpdir(), 'activation-readiness-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const release = { id: `${maker.slice(2)}-clmm`, version: 1, digest: hash };
  await activationStore(stateDir).insert({ id: '00000000-0000-4000-8000-000000000001', maker, transactionHash: hash,
    plan: { release, strategyHash: hash, catalogEntry: { release, strategyHash: hash, programDeadline: 300 } } });
  const activated = await readLpReadiness({ ...config, stateDir, strategies: [] }, maker, { listingId: `${release.id}.v1`, strategyHash: hash }, { client, nowMs: () => 100000 });
  assert.equal(activated.phase, 'ready-for-quote');
  await assert.rejects(readLpReadiness(config, maker, { listingId: 's', strategyHash: hash }, { client, nowMs: () => 200000 }), /stale/);
  report.router = maker;
  await assert.rejects(readLpReadiness(config, maker, { listingId: 's', strategyHash: hash }, { client, nowMs: () => 100000 }), /domain/);
});


test('standing reports stay authorized while freshness and program checks remain bounded', () => {
  const base = { report: { schemaVersion: 2, nonce: 1n, allowedDirections: 3, validAfter: 100, validUntil: 0 },
    activeHash: '0x123', strategyHash: '0x123', now: 10000, programDeadline: 20000,
    raw: [[10n, 2], [10n, 2]], wallets: [10n, 10n], allowances: [10n, 10n] };
  assert.equal(assessReadiness(base).authorized, true);
  assert.equal(assessReadiness({ ...base, activeHash: '0x456' }).authorized, false);
  assert.equal(assessReadiness({ ...base, report: { ...base.report, schemaVersion: 1 } }).authorized, false);
  assert.equal(assessReadiness({ ...base, report: { ...base.report, schemaVersion: 3 } }).authorized, false);
});
