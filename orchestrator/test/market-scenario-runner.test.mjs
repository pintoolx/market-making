import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { scenarioRunConfig } from '../src/market-scenario-runner.mjs';

test('operator scenario command pins the target, Maker, deployment and provisioned strategy', async () => {
  const projectDir = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../../workflow');
  const workflow = JSON.parse(await readFile(resolve(projectDir, 'market-scenarios/config.normal.json'), 'utf8'));
  const env = { CRE_PROJECT_DIR: projectDir, MANDATE_CHAIN_ID: '11155111', MANDATE_STRATEGY_MAKER: workflow.maker,
    MANDATE_GUARD_ADDRESS: workflow.guard, MANDATE_ROUTER_ADDRESS: workflow.router,
    MANDATE_STRATEGY_CATALOG: JSON.stringify({ tight: { name: 'Tight', provider: 'Provider', strategyHash: workflow.strategyHash } }),
    MANDATE_RPC_URL: 'https://rpc.example', MANDATE_NETWORK_NAME: 'Ethereum Sepolia',
    MANDATE_EXPLORER_URL: 'https://sepolia.etherscan.io', MANDATE_RUNNER: '/unused' };
  const config = await scenarioRunConfig('normal-v1', 'tight', env);
  assert.equal(config.simulation.target, 'normal-scenario-settings');
  assert.equal(config.simulation.workflowDir, 'market-scenarios');
  await assert.rejects(scenarioRunConfig('caller-custom', 'tight', env), /Choose/);
  await assert.rejects(scenarioRunConfig('normal-v1', 'unknown', env), /not provisioned/);
  await assert.rejects(scenarioRunConfig('normal-v1', 'tight', { ...env, MANDATE_CHAIN_ID: '1' }), /Sepolia/);
  await assert.rejects(scenarioRunConfig('normal-v1', 'tight', { ...env, MANDATE_STRATEGY_MAKER: `0x${'11'.repeat(20)}` }), /does not match/);
});
