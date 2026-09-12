import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeServer } from '../src/server.mjs';

const h = digit => `0x${digit.repeat(64)}`;
const tx = h('a');
const state = { mandateId: 'mandate-http', regime: 'normal', strategies: [{ listingId: 'featured-tight-market', name: 'Tight Market', strategyHash: h('b'), status: 'active', maxAmountPerSwapAtomic: '100000000' }],
  evidence: { chainId: 84532, networkName: 'Base Sepolia', reportDigest: h('c'), reportTransactionHash: tx,
    reportExplorerUrl: `https://sepolia.basescan.org/tx/${tx}`, sequence: '1', expiresAt: '2026-09-12T12:00:00.000Z' }, events: [] };
const input = { maker: '0x1111111111111111111111111111111111111111', providerStrategyIds: ['featured-tight-market'], policy: {
  capitalBudgetUsdc: '1000', maxWethExposurePct: '60', maxWethInventoryUsdc: '350', maxSwapUsdc: '100', validityMinutes: '10' } };

test('HTTP API serves the frontend contract and rejects other origins', async t => {
  const config = { port: 0, allowedOrigin: 'http://localhost:3200', runner: '/unused', runnerTimeoutMs: 1000,
    chainId: 84532, networkName: 'Base Sepolia', rpcUrl: 'http://unused', explorerUrl: 'https://sepolia.basescan.org', stateDir: await mkdtemp(join(tmpdir(), 'pintool-http-')) };
  const server = makeServer(config, { runner: async () => structuredClone(state), verifyReceipt: async () => ({ chainId: 84532 }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/v1/mandates`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' }, body: JSON.stringify(input) });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).mandateId, state.mandateId);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const denied = await fetch(`${base}/v1/mandates/${state.mandateId}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
});
