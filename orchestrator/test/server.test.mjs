import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeServer } from '../src/server.mjs';

const h = digit => `0x${digit.repeat(64)}`;
const tx = h('a');
const state = { mandateId: 'mandate-http', maker: '0x1111111111111111111111111111111111111111', regime: 'normal', strategies: [{ listingId: 'featured-tight-market', name: 'Tight Market', strategyHash: h('b'), status: 'active', maxAmountPerSwapAtomic: '100000000' }],
  evidence: { chainId: 84532, networkName: 'Base Sepolia', reportDigest: h('c'), reportTransactionHash: tx,
    reportExplorerUrl: `https://sepolia.basescan.org/tx/${tx}`, sequence: '1', expiresAt: '2026-09-12T12:00:00.000Z' }, events: [] };
const input = { maker: '0x1111111111111111111111111111111111111111', providerStrategyIds: ['featured-tight-market'], makerLimitsEnvelope: {
  version: 1, ephemeralPublicKey: '11'.repeat(32), nonce: '22'.repeat(24), ciphertext: '33'.repeat(48) } };

test('HTTP API serves the frontend contract and rejects other origins', async t => {
  const config = { port: 0, allowedOrigin: 'http://localhost:3200', runner: '/unused', runnerTimeoutMs: 1000,
    chainId: 84532, networkName: 'Base Sepolia', rpcUrl: 'http://unused', explorerUrl: 'https://sepolia.basescan.org', router: '0x2222222222222222222222222222222222222222',
    strategyMaker: '0x1111111111111111111111111111111111111111', strategies: [{ id: 'featured-tight-market', name: 'Tight Market', provider: 'PinTool Strategies', strategyHash: h('b') }], stateDir: await mkdtemp(join(tmpdir(), 'pintool-http-')) };
  const server = makeServer(config, { runner: async () => structuredClone(state), verifyReceipt: async () => ({ chainId: 84532 }),
    verifyAquaSwap: async () => ({ chainId: 84532, occurredAt: '2026-09-12T12:01:00.000Z' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', chainId: 84532, network: 'Base Sepolia' });
  const catalog = await fetch(`${base}/v1/strategies`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { maker: config.strategyMaker, strategies: config.strategies });
  const created = await fetch(`${base}/v1/mandates`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' }, body: JSON.stringify(input) });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).mandateId, state.mandateId);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const history = await fetch(`${base}/v1/mandates?maker=${input.maker}`);
  assert.equal(history.status, 200);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await history.json()).mandates.map(item => item.mandateId), [state.mandateId]);
  assert.equal((await fetch(`${base}/v1/mandates`)).status, 400);
  assert.equal((await fetch(`${base}/v1/mandates?maker=bad`)).status, 400);

  const execution = await fetch(`${base}/v1/mandates/${state.mandateId}/executions`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' },
    body: JSON.stringify({ providerStrategyId: 'featured-tight-market', transactionHash: h('d'), outcome: 'settled' }) });
  assert.equal(execution.status, 200);
  assert.equal((await execution.json()).events[0].type, 'swap-settled');
  const denied = await fetch(`${base}/v1/mandates/${state.mandateId}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
});

test('configured wallet trading preserves a complete activation reference and rejects partial or foreign references', async () => {
  const { configFromEnv } = await import('../src/server.mjs');
  const maker = `0x${'11'.repeat(20)}`;
  const entry = { name: 'Provisioned strategy', provider: 'Provider', strategyHash: h('a'), maker, shipTransaction: h('b') };
  const env = { MANDATE_RUNNER: '/unused', MANDATE_ROUTER_ADDRESS: `0x${'22'.repeat(20)}`, MANDATE_STRATEGY_MAKER: maker,
    MANDATE_STRATEGY_CATALOG: JSON.stringify({ strategy: entry }) };
  const config = configFromEnv(env);
  assert.equal(config.strategies[0].shipTransaction, h('b'));
  assert.equal(config.strategies[0].maker, maker);
  for (const patch of [{ maker: undefined }, { shipTransaction: undefined }, { maker: `0x${'33'.repeat(20)}` }]) {
    assert.throws(() => configFromEnv({ ...env, MANDATE_STRATEGY_CATALOG: JSON.stringify({ strategy: { ...entry, ...patch } }) }));
  }
});

test('Builder handler is mounted under the existing mandate service without a second listener', async t => {
  const config = { port: 0, allowedOrigin: 'http://localhost:3200', runner: '/unused', runnerTimeoutMs: 1000,
    chainId: 84532, networkName: 'Base Sepolia', rpcUrl: 'http://unused', explorerUrl: 'https://sepolia.basescan.org', router: `0x${'22'.repeat(20)}`,
    strategyMaker: `0x${'11'.repeat(20)}`, strategies: [], stateDir: await mkdtemp(join(tmpdir(), 'pintool-builder-mount-')) };
  const builderHandler = async (request, response) => {
    if (request.url !== '/v1/builder/capabilities') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mounted: true }));
    return true;
  };
  const server = makeServer(config, { builderHandler });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/builder/capabilities`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mounted: true });
  assert.equal((await fetch(`${base}/v1/builder/unknown`)).status, 404);
});
