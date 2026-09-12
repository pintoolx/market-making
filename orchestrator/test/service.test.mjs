import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createService, HttpError, parseCreate, validateState, verifyReceipt } from '../src/service.mjs';

const hash = digit => `0x${digit.repeat(64)}`;
const tx = hash('a');
const state = {
  mandateId: 'mandate-01', regime: 'normal',
  strategies: [{ listingId: 'featured-tight-market', name: 'Tight Market', provider: 'PinTool Strategies', strategyHash: hash('b'), status: 'active', maxAmountPerSwapAtomic: '100000000' }],
  evidence: { chainId: 84532, networkName: 'Base Sepolia', reportDigest: hash('c'), reportTransactionHash: tx,
    reportExplorerUrl: `https://sepolia.basescan.org/tx/${tx}`, sequence: '1', expiresAt: '2026-09-12T12:00:00.000Z' },
  events: [{ id: 'event-1', type: 'report-accepted', title: 'Guard report accepted', detail: 'Authorization updated.', occurredAt: '2026-09-12T11:50:00.000Z', transactionHash: tx, explorerUrl: `https://sepolia.basescan.org/tx/${tx}` }],
};
const config = { chainId: 84532, networkName: 'Base Sepolia', explorerUrl: 'https://sepolia.basescan.org', rpcUrl: 'http://rpc.invalid', stateDir: '', runner: '/unused', runnerTimeoutMs: 1000 };
const input = { maker: '0x1111111111111111111111111111111111111111', providerStrategyIds: ['featured-tight-market'], policy: {
  capitalBudgetUsdc: '1000', maxWethExposurePct: '60', maxWethInventoryUsdc: '350', maxSwapUsdc: '100', validityMinutes: '10' } };

test('private policy is validated for forwarding without broadening its limits', () => {
  assert.deepEqual(parseCreate(input), input);
  assert.throws(() => parseCreate({ ...input, policy: { ...input.policy, maxSwapUsdc: '1001' } }), HttpError);
  assert.throws(() => parseCreate({ ...input, debug: true }), HttpError);
});

test('state accepts one active strategy and exact configured chain evidence', () => {
  assert.equal(validateState(structuredClone(state), config).mandateId, state.mandateId);
  assert.throws(() => validateState({ ...state, evidence: { ...state.evidence, chainId: 11155111 } }, config), /wrong-network/);
  assert.throws(() => validateState({ ...state, strategies: [...state.strategies, { ...state.strategies[0], listingId: 'second', status: 'active' }] }, config), /strategy set/);
});

test('receipt verification requires a matching successful transaction', async () => {
  const response = (result, chain = '0x14a34') => async () => ({ ok: true, json: async () => [
    { jsonrpc: '2.0', id: 1, result: chain }, { jsonrpc: '2.0', id: 2, result },
  ] });
  assert.equal((await verifyReceipt('http://rpc', tx, '0x1', response({ transactionHash: tx, status: '0x1' }))).receipt.status, '0x1');
  await assert.rejects(verifyReceipt('http://rpc', tx, '0x1', response({ transactionHash: tx, status: '0x0' })), /does not match/);
  await assert.rejects(verifyReceipt('http://rpc', tx, '0x1', response(null)), /unavailable/);
});

test('service forwards secrets only to runner, verifies receipt, and persists public state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-mandates-'));
  const calls = [], receipts = [];
  const service = createService({ ...config, stateDir: dir }, { runner: async request => { calls.push(request); return structuredClone(state); }, verifyReceipt: async (hash, status) => { receipts.push([hash, status]); return { chainId: 84532 }; } });
  assert.equal((await service.create(input)).mandateId, state.mandateId);
  assert.deepEqual(calls[0], { action: 'create', input });
  assert.deepEqual(receipts, [[tx, '0x1']]);
  const saved = await readFile(join(dir, 'mandate-01.json'), 'utf8');
  assert.ok(!saved.includes('capitalBudgetUsdc'));
  assert.equal(JSON.parse(saved).evidence.reportTransactionHash, tx);
});

test('service rejects evidence for a different strategy than the user selected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-mandates-'));
  const service = createService({ ...config, stateDir: dir }, { runner: async () => ({ ...structuredClone(state), strategies: [{ ...state.strategies[0], listingId: 'featured-defensive-market' }] }), verifyReceipt: async () => ({ chainId: 84532 }) });
  await assert.rejects(service.create(input), /does not contain the requested strategy set/);
});

test('get may use verified public cache during a runner outage; add may not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-mandates-'));
  let online = true;
  const service = createService({ ...config, stateDir: dir }, { runner: async request => {
    if (!online) throw new Error('offline');
    return request.action === 'add-strategy' ? { ...state, strategies: [...state.strategies, { ...state.strategies[0], listingId: request.providerStrategyId, status: 'standby' }] } : structuredClone(state);
  }, verifyReceipt: async () => {} });
  await service.create(input); online = false;
  assert.equal((await service.get(state.mandateId)).mandateId, state.mandateId);
  await assert.rejects(service.add(state.mandateId, { providerStrategyId: 'featured-defensive-market' }), /offline/);
});
