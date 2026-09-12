import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDirectMandate } from '../src/cre-mandate-runner.mjs';

const maker = '0x1111111111111111111111111111111111111111';
const strategyHash = `0x${'22'.repeat(32)}`;
const defensiveHash = `0x${'55'.repeat(32)}`;
const txHash = `0x${'33'.repeat(32)}`;
const digest = `0x${'44'.repeat(32)}`;
const makerLimitsEnvelope = { version: 1, ephemeralPublicKey: '11'.repeat(32), nonce: '22'.repeat(24), ciphertext: '33'.repeat(48) };
const config = {
  gatewayUrl: 'https://gateway.example', workflowId: 'aa'.repeat(32), privateKey: `0x${'11'.repeat(32)}`,
  rpcUrl: 'https://rpc.example', explorerUrl: 'https://explorer.example', networkName: 'Ethereum Sepolia',
  chainId: 11155111, guard: '0x5555555555555555555555555555555555555555',
  catalog: {
    'featured-tight-market': { name: 'Tight Market', provider: 'PinTool Strategies', strategyHash },
    'featured-defensive-market': { name: 'Defensive Market', provider: 'PinTool Strategies', strategyHash: defensiveHash },
  },
  marketSnapshot: { midPrice: '2500', volatilityBps: 200, balance0: '1', balance1: '1000', decimals0: 18, decimals1: 6 },
  timeoutMs: 1000,
};

test('direct CRE runner turns an accepted trigger and matching Guard event into public mandate state', async () => {
  let triggerInput;
  const state = await runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'], makerLimitsEnvelope } }, config, {
    currentBlock: async () => 42n,
    trigger: async (_config, input) => { triggerInput = input; return { workflowExecutionId: 'execution-1', status: 'ACCEPTED' }; },
    observe: async observed => {
      assert.equal(observed.fromBlock, 42n);
      return {
        transactionHash: txHash,
        digest,
        report: { maker, strategyHash, nonce: 7n, validUntil: 1_900_000_000, allowedDirections: 3, maxAmount1PerSwap: 100_000_000n },
      };
    },
  });
  assert.equal(triggerInput.maker, maker);
  assert.equal(triggerInput.strategyHash, strategyHash);
  assert.deepEqual(triggerInput.makerLimitsEnvelope, makerLimitsEnvelope);
  assert.equal(state.strategies[0].status, 'active');
  assert.equal(state.strategies[0].maxAmountPerSwapAtomic, '100000000');
  assert.equal(state.evidence.reportTransactionHash, txHash);
  assert.equal(state.evidence.sequence, '7');
  assert.equal(state.events.length, 2);

  const expanded = await runDirectMandate({
    action: 'add-strategy',
    mandateId: state.mandateId,
    providerStrategyId: 'featured-defensive-market',
    makerLimitsEnvelope,
    current: state,
  }, config, {
    currentBlock: async () => 43n,
    trigger: async (_config, input) => {
      assert.equal(input.strategyHash, defensiveHash);
      return { workflowExecutionId: 'execution-2', status: 'ACCEPTED' };
    },
    observe: async () => ({
      transactionHash: `0x${'66'.repeat(32)}`,
      digest: `0x${'77'.repeat(32)}`,
      report: { maker, strategyHash: defensiveHash, nonce: 8n, validUntil: 1_900_000_100, allowedDirections: 3, maxAmount1PerSwap: 50_000_000n },
    }),
  });
  assert.deepEqual(expanded.strategies.map(item => [item.listingId, item.status]), [
    ['featured-tight-market', 'standby'],
    ['featured-defensive-market', 'active'],
  ]);
  assert.equal(expanded.mandateId, state.mandateId);
  assert.equal(expanded.events.length, 4);
});

test('direct CRE runner rejects unprovisioned strategies and missing sealed limits', async () => {
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['missing'], makerLimitsEnvelope } }, config), /not provisioned/);
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'] } }, config), /sealed limits/);
  await assert.rejects(runDirectMandate({ action: 'add-strategy' }, config), /Current mandate state/);
});

test('a paused candidate does not replace the currently active strategy in public state', async () => {
  const current = {
    mandateId: 'mandate-existing',
    maker,
    regime: 'normal',
    strategies: [{ listingId: 'featured-tight-market', name: 'Tight Market', strategyHash, status: 'active', maxAmountPerSwapAtomic: '100000000' }],
    evidence: {},
    events: [],
  };
  const state = await runDirectMandate({
    action: 'add-strategy',
    mandateId: current.mandateId,
    providerStrategyId: 'featured-defensive-market', makerLimitsEnvelope,
    current,
  }, config, {
    currentBlock: async () => 50n,
    trigger: async () => ({ workflowExecutionId: 'execution-paused', status: 'ACCEPTED' }),
    observe: async () => ({
      transactionHash: txHash,
      digest,
      report: { maker, strategyHash: defensiveHash, nonce: 2n, validUntil: 1_900_000_000, allowedDirections: 0, maxAmount1PerSwap: 0n },
    }),
  });
  assert.deepEqual(state.strategies.map(item => [item.listingId, item.status]), [
    ['featured-tight-market', 'active'],
    ['featured-defensive-market', 'paused'],
  ]);
});

test('runner delegates acquisition to CRE and never injects legacy snapshots', async () => {
  let payload;
  const state = await runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'], makerLimitsEnvelope } }, config, {
    currentBlock: async () => 1n,
    trigger: async (_config, input) => { payload = input; return { workflowExecutionId: 'local' }; },
    observe: async () => ({ transactionHash: txHash, digest, report: { maker, strategyHash, nonce: 1n,
      validUntil: 1_900_000_000, allowedDirections: 3, maxAmount1PerSwap: 1n } }),
  });
  assert.equal(state.regime, 'unknown');
  assert.equal('marketSnapshot' in payload, false);
});
