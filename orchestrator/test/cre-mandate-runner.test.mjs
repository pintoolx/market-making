import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyDigest, runDirectMandate } from '../src/cre-mandate-runner.mjs';

const maker = '0x1111111111111111111111111111111111111111';
const strategyHash = `0x${'22'.repeat(32)}`;
const defensiveHash = `0x${'55'.repeat(32)}`;
const txHash = `0x${'33'.repeat(32)}`;
const digest = `0x${'44'.repeat(32)}`;
const policy = {
  capitalBudgetUsdc: '1000', maxWethExposurePct: '60', maxWethInventoryUsdc: '350',
  maxSwapUsdc: '100', validityMinutes: '10',
};
const config = {
  gatewayUrl: 'https://gateway.example', workflowId: 'aa'.repeat(32), privateKey: `0x${'11'.repeat(32)}`,
  rpcUrl: 'https://rpc.example', explorerUrl: 'https://explorer.example', networkName: 'Ethereum Sepolia',
  chainId: 11155111, guard: '0x5555555555555555555555555555555555555555',
  catalog: {
    'featured-tight-market': { name: 'Tight Market', provider: 'PinTool Strategies', strategyHash },
    'featured-defensive-market': { name: 'Defensive Market', provider: 'PinTool Strategies', strategyHash: defensiveHash },
  },
  marketSnapshot: { midPrice: '2500', volatilityBps: 200, balance0: '1', balance1: '1000', decimals0: 18, decimals1: 6 },
  expectedPolicyDigest: policyDigest(policy), timeoutMs: 1000,
};

test('direct CRE runner turns an accepted trigger and matching Guard event into public mandate state', async () => {
  let triggerInput;
  const state = await runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'], policy } }, config, {
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
  assert.equal(state.strategies[0].status, 'active');
  assert.equal(state.strategies[0].maxAmountPerSwapAtomic, '100000000');
  assert.equal(state.evidence.reportTransactionHash, txHash);
  assert.equal(state.evidence.sequence, '7');
  assert.equal(state.events.length, 2);

  const expanded = await runDirectMandate({
    action: 'add-strategy',
    mandateId: state.mandateId,
    providerStrategyId: 'featured-defensive-market',
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

test('direct CRE runner rejects unprovisioned strategies and policy values', async () => {
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['missing'], policy } }, config), /not provisioned/);
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'], policy: { ...policy, maxSwapUsdc: '101' } } }, config), /do not match/);
  await assert.rejects(runDirectMandate({ action: 'add-strategy' }, config), /Current mandate state/);
});
