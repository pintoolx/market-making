import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyDigest, runDirectMandate } from '../src/cre-mandate-runner.mjs';

const maker = '0x1111111111111111111111111111111111111111';
const strategyHash = `0x${'22'.repeat(32)}`;
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
  catalog: { 'featured-tight-market': { name: 'Tight Market', provider: 'PinTool Strategies', strategyHash } },
  marketSnapshot: { midPrice: '2500', volatilityBps: 200, balance0: '1', balance1: '1000', token0Decimals: 18, token1Decimals: 6 },
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
});

test('direct CRE runner rejects unprovisioned strategies and policy values', async () => {
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['missing'], policy } }, config), /not provisioned/);
  await assert.rejects(runDirectMandate({ action: 'create', input: { maker, providerStrategyIds: ['featured-tight-market'], policy: { ...policy, maxSwapUsdc: '101' } } }, config), /do not match/);
  await assert.rejects(runDirectMandate({ action: 'add-strategy' }, config), /creation only/);
});
