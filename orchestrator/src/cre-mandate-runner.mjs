#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { currentBlock, waitForAcceptedReport, latestAcceptedReport } from './guard-observer.mjs';
import { triggerCREWorkflow } from './cre-gateway.mjs';
import { createProviderRegistry } from './provider-registry.mjs';
import { activationCatalog } from './activation-store.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX32 = /^0x[0-9a-f]{64}$/i;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function mandateRunnerConfig(env = process.env) {
  const catalog = JSON.parse(required(env, 'MANDATE_STRATEGY_CATALOG'));
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('MANDATE_STRATEGY_CATALOG must be an object');
  for (const [id, item] of Object.entries(catalog)) {
    if (!id || !item?.name || !HEX32.test(item?.strategyHash ?? '')) throw new Error('MANDATE_STRATEGY_CATALOG contains an invalid strategy');
  }
  const guard = required(env, 'MANDATE_GUARD_ADDRESS');
  if (!ADDRESS.test(guard)) throw new Error('MANDATE_GUARD_ADDRESS is invalid');
  const chainId = Number(required(env, 'MANDATE_CHAIN_ID'));
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('MANDATE_CHAIN_ID is invalid');
  return {
    rpcUrl: required(env, 'MANDATE_RPC_URL'),
    explorerUrl: required(env, 'MANDATE_EXPLORER_URL').replace(/\/$/, ''),
    networkName: required(env, 'MANDATE_NETWORK_NAME'),
    chainId,
    guard,
    catalog,
    stateDir: env.MANDATE_STATE_DIR ?? '.state/mandates',
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
    || input.providerStrategyIds.length !== 1 || !input.makerLimitsEnvelope)) throw new Error('Direct CRE runner requires one valid Maker strategy and sealed limits');
  if (!creating && (!current || current.mandateId !== request.mandateId || !ADDRESS.test(current.maker ?? '')
    || !Array.isArray(current.strategies) || current.strategies.length === 0 || !request.makerLimitsEnvelope)) throw new Error('Current mandate state and sealed limits are required');
  const listingId = creating ? input.providerStrategyIds[0]
    : request.action === 'add-strategy' ? request.providerStrategyId
      : (current.strategies.find(item => item.status === 'active') ?? current.strategies[0]).listingId;
  const activated = config.stateDir ? await activationCatalog(config.stateDir) : {};
  const listing = activated[listingId] ?? config.catalog[listingId];
  if (!listing) throw new Error('Selected strategy is not provisioned for this workflow');
  if (activated[listingId] && config.catalog[listingId] && activated[listingId].strategyHash !== config.catalog[listingId].strategyHash) throw new Error('Conflicting activated strategy');
  if (listing.maker && listing.maker.toLowerCase() !== (creating ? input.maker : current.maker).toLowerCase()) throw new Error('This activation belongs to a different Maker');
  const previous = current?.strategies.find(item => item.listingId === listingId);
  if (previous && previous.strategyHash.toLowerCase() !== listing.strategyHash.toLowerCase()) throw new Error('Catalog changed this strategy; create a new versioned mandate');
  let providerInput = {};
  if (listing.release) {
    if (listingId !== `${listing.release.id}.v${listing.release.version}`) throw new Error('Catalog publication version mismatch');
    const registry = dependencies.registry ?? createProviderRegistry(config.stateDir);
    const [record, latest] = await Promise.all([registry.read(listing.release.id, listing.release.version), registry.latest(listing.release.id)]);
    if (latest?.release.state !== 'published' || listing.release.version <= (latest.withdrawnThrough ?? 0)
      || record.release.state !== 'published' || record.digest !== listing.release.digest) throw new Error('Provider publication is withdrawn or changed');
    providerInput = { provider: record.release.provider, providerStrategyEnvelope: record.envelope };
  }

  const maker = creating ? input.maker : current.maker;
  const mandateId = creating ? `mandate-${randomUUID()}` : request.mandateId;
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
    makerLimitsEnvelope: creating ? input.makerLimitsEnvelope : request.makerLimitsEnvelope,
    ...providerInput,
  }, { fetchImpl: dependencies.fetchImpl });

  const observe = dependencies.observe ?? (accepted.unchanged ? latestAcceptedReport : waitForAcceptedReport);
  const evidence = await observe({
    rpcUrl: config.rpcUrl,
    guard: config.guard,
    maker,
    strategyHash: listing.strategyHash,
    fromBlock,
  }, { fetchImpl: dependencies.fetchImpl, timeoutMs: config.timeoutMs, expectedDigest: accepted.reportDigest });
  const active = evidence.report.allowedDirections > 0;
  const transactionUrl = `${config.explorerUrl}/tx/${evidence.transactionHash}`;
  const events = [{
    id: accepted.unchanged ? `${accepted.workflowExecutionId}-unchanged` : `${evidence.transactionHash}-report`,
    type: accepted.unchanged ? 'authorization-unchanged' : 'report-accepted',
    title: accepted.unchanged ? 'Execution conditions unchanged' : 'Guard authorization confirmed',
    detail: accepted.unchanged ? 'The confidential evaluation confirmed the existing authorization. No new transaction was submitted.' : `CRE execution ${accepted.workflowExecutionId} delivered mandate sequence ${evidence.report.nonce}.`,
    occurredAt: new Date().toISOString(),
    transactionHash: evidence.transactionHash,
    explorerUrl: transactionUrl,
  }];
  if (active && !accepted.unchanged) events.push({
    id: `${evidence.transactionHash}-active`,
    type: 'strategy-activated',
    title: `${listing.name} authorized`,
    detail: 'Guard accepted the authorization. Aqua liquidity, funding and program readiness are checked separately.',
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
    regime: 'unknown', // A public authorization does not disclose the private rule or market regime.
    strategies,
    evidence: {
      chainId: config.chainId,
      networkName: config.networkName,
      reportDigest: evidence.digest,
      reportTransactionHash: evidence.transactionHash,
      reportExplorerUrl: transactionUrl,
      sequence: evidence.report.nonce.toString(),
      expiresAt: Number(evidence.report.schemaVersion) === 2 && Number(evidence.report.validUntil) === 0 ? null : iso(evidence.report.validUntil),
    },
    events: [...events, ...(current?.events ?? []).filter(event => !events.some(next => next.id === event.id))],
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
