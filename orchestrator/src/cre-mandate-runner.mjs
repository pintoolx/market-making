#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { currentBlock, waitForAcceptedReport } from './guard-observer.mjs';
import { stableStringify, triggerCREWorkflow } from './cre-gateway.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX32 = /^0x[0-9a-f]{64}$/i;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function policyDigest(policy) {
  return createHash('sha256').update(stableStringify(policy)).digest('hex');
}

export function mandateRunnerConfig(env = process.env) {
  const catalog = JSON.parse(required(env, 'MANDATE_STRATEGY_CATALOG'));
  const marketSnapshot = JSON.parse(required(env, 'MANDATE_MARKET_SNAPSHOT'));
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('MANDATE_STRATEGY_CATALOG must be an object');
  for (const [id, item] of Object.entries(catalog)) {
    if (!id || !item?.name || !HEX32.test(item?.strategyHash ?? '')) throw new Error('MANDATE_STRATEGY_CATALOG contains an invalid strategy');
  }
  const guard = required(env, 'MANDATE_GUARD_ADDRESS');
  if (!ADDRESS.test(guard)) throw new Error('MANDATE_GUARD_ADDRESS is invalid');
  const chainId = Number(required(env, 'MANDATE_CHAIN_ID'));
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('MANDATE_CHAIN_ID is invalid');
  const expectedPolicyDigest = required(env, 'MANDATE_POLICY_SHA256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedPolicyDigest)) throw new Error('MANDATE_POLICY_SHA256 is invalid');
  return {
    rpcUrl: required(env, 'MANDATE_RPC_URL'),
    explorerUrl: required(env, 'MANDATE_EXPLORER_URL').replace(/\/$/, ''),
    networkName: required(env, 'MANDATE_NETWORK_NAME'),
    chainId,
    guard,
    catalog,
    marketSnapshot,
    marketSnapshotFile: env.MANDATE_MARKET_SNAPSHOT_FILE?.trim() || null,
    expectedPolicyDigest,
    timeoutMs: Number(env.MANDATE_RUNNER_TIMEOUT_MS ?? 120_000),
  };
}

export function directRunnerConfig(env = process.env) {
  return {
    ...mandateRunnerConfig(env),
    gatewayUrl: required(env, 'CRE_GATEWAY_URL'),
    workflowId: required(env, 'CRE_WORKFLOW_ID'),
    privateKey: required(env, 'CRE_HTTP_TRIGGER_PRIVATE_KEY'),
  };
}

function iso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

export async function runDirectMandate(request, config, dependencies = {}) {
  if (!['create', 'get', 'add-strategy'].includes(request?.action)) throw new Error('Direct CRE runner action is unsupported');
  const creating = request.action === 'create';
  const current = creating ? null : request.current;
  const input = request.input;
  if (creating && (!input || !ADDRESS.test(input.maker ?? '') || !Array.isArray(input.providerStrategyIds)
    || input.providerStrategyIds.length !== 1)) throw new Error('Direct CRE runner requires one valid Maker strategy');
  if (creating && policyDigest(input.policy) !== config.expectedPolicyDigest) {
    throw new Error('Maker limits do not match the confidential policy provisioned for this workflow');
  }
  if (!creating && (!current || current.mandateId !== request.mandateId || !ADDRESS.test(current.maker ?? '')
    || !Array.isArray(current.strategies) || current.strategies.length === 0)) throw new Error('Current mandate state is required');
  const listingId = creating ? input.providerStrategyIds[0]
    : request.action === 'add-strategy' ? request.providerStrategyId
      : (current.strategies.find(item => item.status === 'active') ?? current.strategies[0]).listingId;
  const listing = config.catalog[listingId];
  if (!listing) throw new Error('Selected strategy is not provisioned for this workflow');

  const maker = creating ? input.maker : current.maker;
  const mandateId = creating ? `mandate-${randomUUID()}` : request.mandateId;
  const marketSnapshot = config.marketSnapshotFile
    ? JSON.parse(await readFile(config.marketSnapshotFile, 'utf8'))
    : config.marketSnapshot;
  const fromBlock = await (dependencies.currentBlock ?? currentBlock)(config.rpcUrl, dependencies.fetchImpl);
  const trigger = dependencies.trigger ?? triggerCREWorkflow;
  const accepted = await trigger(dependencies.triggerConfig ?? {
    gatewayUrl: config.gatewayUrl,
    workflowId: config.workflowId,
    privateKey: config.privateKey,
  }, {
    requestId: mandateId,
    maker,
    strategyHash: listing.strategyHash,
    marketSnapshot,
  }, { fetchImpl: dependencies.fetchImpl });

  const observe = dependencies.observe ?? waitForAcceptedReport;
  const evidence = await observe({
    rpcUrl: config.rpcUrl,
    guard: config.guard,
    maker,
    strategyHash: listing.strategyHash,
    fromBlock,
  }, { fetchImpl: dependencies.fetchImpl, timeoutMs: config.timeoutMs });
  const active = evidence.report.allowedDirections > 0;
  const transactionUrl = `${config.explorerUrl}/tx/${evidence.transactionHash}`;
  const events = [{
    id: `${evidence.transactionHash}-report`,
    type: 'report-accepted',
    title: 'Guard authorization confirmed',
    detail: `CRE execution ${accepted.workflowExecutionId} delivered mandate sequence ${evidence.report.nonce}.`,
    occurredAt: new Date().toISOString(),
    transactionHash: evidence.transactionHash,
    explorerUrl: transactionUrl,
  }];
  if (active) events.push({
    id: `${evidence.transactionHash}-active`,
    type: 'strategy-activated',
    title: `${listing.name} authorized`,
    detail: 'The strategy may execute within the confirmed Guard limits.',
    occurredAt: new Date().toISOString(),
    transactionHash: evidence.transactionHash,
    explorerUrl: transactionUrl,
  });
  const selectedState = {
    listingId,
    name: listing.name,
    provider: listing.provider,
    strategyHash: listing.strategyHash,
    status: active ? 'active' : 'paused',
    maxAmountPerSwapAtomic: evidence.report.maxAmount1PerSwap.toString(),
  };
  const strategies = creating ? [selectedState] : [
    ...current.strategies.filter(item => item.listingId !== listingId).map(item => ({ ...item, status: active ? 'standby' : item.status })),
    selectedState,
  ];
  return {
    mandateId,
    maker,
    regime: Number(marketSnapshot.volatilityBps) >= 301 ? 'high-volatility' : 'normal',
    strategies,
    evidence: {
      chainId: config.chainId,
      networkName: config.networkName,
      reportDigest: evidence.digest,
      reportTransactionHash: evidence.transactionHash,
      reportExplorerUrl: transactionUrl,
      sequence: evidence.report.nonce.toString(),
      expiresAt: iso(evidence.report.validUntil),
    },
    events: [...events, ...(current?.events ?? [])],
  };
}

async function readStdin() {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 64_000) throw new Error('runner input exceeded limit');
  }
  return JSON.parse(body);
}

export async function main() {
  const result = await runDirectMandate(await readStdin(), directRunnerConfig());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'direct CRE runner failed'}\n`);
    process.exitCode = 1;
  });
}
