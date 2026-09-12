import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { createService, HttpError, parseCreate, validateState, verifyAquaSwap, verifyReceipt } from '../src/service.mjs';

const hash = digit => `0x${digit.repeat(64)}`;
const tx = hash('a');
const inputMaker = '0x1111111111111111111111111111111111111111';
const state = {
  mandateId: 'mandate-01', maker: inputMaker, regime: 'normal',
  strategies: [{ listingId: 'featured-tight-market', name: 'Tight Market', provider: 'PinTool Strategies', strategyHash: hash('b'), status: 'active', maxAmountPerSwapAtomic: '100000000' }],
  evidence: { chainId: 84532, networkName: 'Base Sepolia', reportDigest: hash('c'), reportTransactionHash: tx,
    reportExplorerUrl: `https://sepolia.basescan.org/tx/${tx}`, sequence: '1', expiresAt: '2026-09-12T12:00:00.000Z' },
  events: [{ id: 'event-1', type: 'report-accepted', title: 'Guard report accepted', detail: 'Authorization updated.', occurredAt: '2026-09-12T11:50:00.000Z', transactionHash: tx, explorerUrl: `https://sepolia.basescan.org/tx/${tx}` }],
};
const router = '0x2222222222222222222222222222222222222222';
const config = { chainId: 84532, networkName: 'Base Sepolia', explorerUrl: 'https://sepolia.basescan.org', rpcUrl: 'http://rpc.invalid', router, stateDir: '', runner: '/unused', runnerTimeoutMs: 1000 };
const input = { maker: inputMaker, providerStrategyIds: ['featured-tight-market'], policy: {
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

test('Aqua evidence is bound to the Router calldata strategy hash and a matching swap event', async () => {
  const abi = parseAbi([
    'struct Order { address maker; uint256 traits; bytes data; }',
    'function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
    'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  ]);
  const order = { maker: inputMaker, traits: 1n, data: '0x1234' };
  const strategyHash = keccak256(encodeAbiParameters([{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [order]));
  const inputData = encodeFunctionData({ abi, functionName: 'swap', args: [order, inputMaker, router, 10n, '0x'] });
  const topics = encodeEventTopics({ abi, eventName: 'Swapped' });
  const data = encodeAbiParameters([
    { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
  ], [strategyHash, inputMaker, router, inputMaker, router, 10n, 9n]);
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    if (Array.isArray(body)) return { ok: true, json: async () => [
      { id: 1, result: '0x14a34' },
      { id: 2, result: { transactionHash: tx, status: '0x1', blockNumber: '0x10', logs: [{ address: router, topics, data }] } },
      { id: 3, result: { hash: tx, to: router, input: inputData } },
    ] };
    return { ok: true, json: async () => ({ id: 4, result: { timestamp: '0x6b49d200' } }) };
  };
  const evidence = await verifyAquaSwap('http://rpc', router, tx, strategyHash, '0x1', fetchImpl);
  assert.equal(evidence.chainId, 84532);
  assert.equal(evidence.strategyHash, strategyHash);
  assert.equal(calls, 2);
  await assert.rejects(verifyAquaSwap('http://rpc', router, tx, hash('d'), '0x1', fetchImpl), /different strategy/);
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

test('get and add pass only previously verified public state to the runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-mandates-'));
  const calls = [];
  const service = createService({ ...config, stateDir: dir }, {
    runner: async request => {
      calls.push(request);
      if (request.action === 'add-strategy') return {
        ...structuredClone(state),
        strategies: [...state.strategies.map(item => ({ ...item, status: 'standby' })),
          { ...state.strategies[0], listingId: request.providerStrategyId, status: 'active' }],
      };
      return structuredClone(state);
    },
    verifyReceipt: async () => ({ chainId: 84532 }),
  });
  await service.create(input);
  await service.get(state.mandateId);
  await service.add(state.mandateId, { providerStrategyId: 'featured-defensive-market' });
  assert.deepEqual(calls[1], { action: 'get', mandateId: state.mandateId, current: state });
  assert.equal(calls[2].current.mandateId, state.mandateId);
  assert.equal(calls[2].providerStrategyId, 'featured-defensive-market');
  assert.ok(!JSON.stringify(calls[2].current).includes('capitalBudgetUsdc'));
});

test('service records only verified Aqua settlement and Guard rejection receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-executions-'));
  const second = { listingId: 'featured-defensive-market', name: 'Defensive Market', provider: 'PinTool Strategies', strategyHash: hash('d'), status: 'standby', maxAmountPerSwapAtomic: '500000' };
  const initial = { ...structuredClone(state), strategies: [...state.strategies, second] };
  const verified = [];
  const service = createService({ ...config, stateDir: dir }, {
    runner: async () => structuredClone(initial), verifyReceipt: async () => ({ chainId: 84532 }),
    verifyAquaSwap: async (...args) => { verified.push(args); return { chainId: 84532, occurredAt: '2026-09-12T12:01:00.000Z' }; },
  });
  await service.create(input);
  const settled = await service.recordExecution(state.mandateId, { providerStrategyId: 'featured-tight-market', transactionHash: hash('e'), outcome: 'settled' });
  assert.equal(settled.events[0].type, 'swap-settled');
  assert.deepEqual(verified[0], [hash('e'), state.strategies[0].strategyHash, '0x1']);
  const duplicate = await service.recordExecution(state.mandateId, { providerStrategyId: 'featured-tight-market', transactionHash: hash('e'), outcome: 'settled' });
  assert.equal(duplicate.events.filter(event => event.transactionHash === hash('e')).length, 1);
  const rejected = await service.recordExecution(state.mandateId, { providerStrategyId: 'featured-defensive-market', transactionHash: hash('f'), outcome: 'rejected' });
  assert.equal(rejected.events[0].type, 'swap-rejected');
  assert.deepEqual(verified[1], [hash('f'), second.strategyHash, '0x0']);
  await assert.rejects(service.recordExecution(state.mandateId, { providerStrategyId: 'featured-tight-market', transactionHash: hash('9'), outcome: 'rejected' }), HttpError);
});
