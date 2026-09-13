import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sepoliaStandingProfile } from '../../packages/strategy-builder/src/index.ts';
import { createRpcBindingVerifier } from './builder-binding-verifier.mjs';
import { createWalletChain } from '../../packages/builder-service/src/wallet-chain.ts';

/**
 * The Builder is mounted into the existing mandate service instead of running
 * a second HTTP listener. This module owns the database pool and the durable
 * workers; secrets are consumed by their adapters and are never included in
 * logs or worker context.
 */
export async function createBuilderRuntime(config, env = process.env, dependencies = {}) {
  const enabled = env.BUILDER_ENABLED !== 'false' && (env.BUILDER_ENABLED === 'true' || Boolean(env.DATABASE_URL?.trim()));
  if (!enabled) return { enabled: false, handler: undefined, start() {}, async close() {} };
  if (!env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required when BUILDER_ENABLED=true');

  const {
    database, migrate, builderHandler, runDesignTurn, createTurns, openAIModel,
    nativeInventoryAdapter, krakenTemplatePrice, runEventWorker,
    createHttpEventGateway, createEvmLogSource,
  } = await import('../../packages/builder-service/src/index.ts');
  const { createSignedEventIngress } = await import('../../packages/builder-service/src/event-adapters.ts');
  const { createKrakenMarketSource } = await import('../../packages/builder-service/src/market-source.ts');

  const pool = database(env.DATABASE_URL);
  await migrate(pool);
  const profileId = env.BUILDER_PROFILE_ID?.trim() || sepoliaStandingProfile.id;
  const designEnabled = env.BUILDER_DESIGN_ENABLED !== 'false' && Boolean(env.OPENAI_API_KEY?.trim());
  const simulationEnabled = env.BUILDER_SIMULATION_ENABLED === 'true';
  const eventWorkerEnabled = env.BUILDER_EVENT_WORKER_ENABLED === 'true';
  const profile = profileId === sepoliaStandingProfile.id ? sepoliaStandingProfile : undefined;
  if (profile && config.chainId !== profile.chainId) throw new Error('Builder profile and mandate chain differ');
  const eventIngressSecret = env.BUILDER_EVENT_INGRESS_SECRET?.trim();
  const eventIngress = eventIngressSecret ? createSignedEventIngress(eventIngressSecret, {
    maxAgeSeconds: integer(env.BUILDER_EVENT_INGRESS_MAX_AGE_SECONDS, 300),
  }) : undefined;
  const inventoryEnabled = env.BUILDER_INVENTORY_ENABLED === 'true';
  const templatesKey = env.BUILDER_WORKFLOW_PUBLIC_KEY?.trim();
  const bindingDependencies = dependencies.binding ?? { verifyReport: createRpcBindingVerifier(config.rpcUrl) };
  const handler = builderHandler(pool, {
    origin: config.allowedOrigin,
    chainId: config.chainId,
    profileId,
    designEnabled,
    simulationEnabled,
    outagePolicyEnabled: eventWorkerEnabled && env.BUILDER_EVENT_ADAPTER === 'cre-simulation',
    ...(env.PRIVY_APP_ID ? { privyAppId: env.PRIVY_APP_ID } : {}),
  }, {
    ...(profile && env.BUILDER_WALLET_ENABLED === 'true' ? { walletChain: createWalletChain(profile, { rpcUrl: config.rpcUrl }) } : {}),
    ...(inventoryEnabled && profile ? {
      inventoryAdapter: nativeInventoryAdapter(profile, {
        rpcUrl: env.BUILDER_INVENTORY_RPC_URL || config.rpcUrl,
      }),
    } : {}),
    ...(templatesKey && profile ? {
      templates: { workflowPublicKey: templatesKey, price: krakenTemplatePrice },
    } : {}),
    ...(eventIngress ? { eventIngress } : {}),
    ...(bindingDependencies ? { binding: bindingDependencies } : {}),
  });
  const evaluatorUrl = env.BUILDER_EVENT_EVALUATOR_URL?.trim();
  const deliveryUrl = env.BUILDER_EVENT_DELIVERY_URL?.trim();
  const gatewayToken = env.BUILDER_EVENT_GATEWAY_TOKEN?.trim();
  const configuredGatewayValues = [evaluatorUrl, deliveryUrl, gatewayToken].filter(Boolean).length;
  if (eventWorkerEnabled && configuredGatewayValues > 0 && configuredGatewayValues < 3)
    throw new Error('Builder event gateway requires evaluator URL, delivery URL and token together');
  const configuredEventGateway = eventWorkerEnabled && evaluatorUrl && deliveryUrl && gatewayToken
    ? createHttpEventGateway({ evaluatorUrl, deliveryUrl, token: gatewayToken, timeoutMs: integer(env.BUILDER_EVENT_GATEWAY_TIMEOUT_MS, 120000) }) : undefined;
  let configuredCreBridge;
  if (eventWorkerEnabled && env.BUILDER_EVENT_ADAPTER === 'cre-simulation') {
    if (configuredEventGateway || !profile || !templatesKey || !env.BUILDER_CRE_PROJECT_DIRECTORY || env.BUILDER_CRE_EXCLUSIVE_BROADCASTER !== 'true')
      throw new Error('CRE simulation requires a profile, public workflow key, project directory and exclusive broadcaster; remove HTTP gateway configuration');
    const projectDirectory = resolve(env.BUILDER_CRE_PROJECT_DIRECTORY);
    const baseConfig = JSON.parse(await readFile(resolve(projectDirectory, 'market-maker-auth/config.staging.json'), 'utf8'));
    const { createBuilderCreBridge } = await import('./builder-cre-bridge.mjs');
    configuredCreBridge = createBuilderCreBridge(pool, profile, {
      baseConfig, projectDirectory, origin: config.allowedOrigin, workflowPublicKey: templatesKey, rpcUrl: config.rpcUrl,
      environmentFile: env.BUILDER_CRE_ENV_FILE || '/dev/null', env,
      broadcastEnabled: env.BUILDER_CRE_BROADCAST_ENABLED === 'true', timeoutMs: 120000,
    });
    if (env.BUILDER_EVENT_LEASE_MS && integer(env.BUILDER_EVENT_LEASE_MS, 300000) < 240000)
      throw new Error('CRE simulation requires an evaluation lease of at least 240000 ms');
  } else if (eventWorkerEnabled && env.BUILDER_EVENT_ADAPTER && env.BUILDER_EVENT_ADAPTER !== 'http') {
    throw new Error('unsupported Builder event adapter');
  }
  const eventSourceAddress = env.BUILDER_EVENT_EVM_ADDRESS?.trim();
  const eventSourceAddresses = env.BUILDER_EVENT_EVM_ADDRESSES?.trim();
  if (eventWorkerEnabled && eventSourceAddress && eventSourceAddresses) throw new Error('Choose one Builder EVM address configuration');
  const eventSourceFromBlock = env.BUILDER_EVENT_EVM_FROM_BLOCK?.trim();
  const configuredEventSourceValues = [eventSourceAddress || eventSourceAddresses, eventSourceFromBlock].filter(Boolean).length;
  if (eventWorkerEnabled && configuredEventSourceValues > 0 && configuredEventSourceValues < 2)
    throw new Error('Builder EVM event source requires address and from block together');
  const addresses = eventWorkerEnabled && eventSourceAddresses ? JSON.parse(eventSourceAddresses) : eventSourceAddress ? [eventSourceAddress] : [];
  const allowedAddresses = profile ? [profile.aqua, profile.router, profile.guard, ...profile.tokens.map(t => t.address)] : [];
  if (!Array.isArray(addresses) || addresses.length > 8 || new Set(addresses.map(a => typeof a === 'string' ? a.toLowerCase() : a)).size !== addresses.length ||
    (eventSourceAddresses && addresses.some(a => typeof a !== 'string' || !allowedAddresses.includes(a.toLowerCase()))))
    throw new Error('Builder EVM addresses must be unique contracts from the selected profile');
  const configuredEventSources = eventWorkerEnabled && eventSourceFromBlock
    ? addresses.map(address => createEvmLogSource({
      source: eventSourceAddresses ? `chain.${profile.chainId}.${address.toLowerCase()}` : env.BUILDER_EVENT_EVM_SOURCE?.trim() || `chain.${profile?.chainId ?? config.chainId}.evm`,
      rpcUrl: env.BUILDER_EVENT_EVM_RPC_URL?.trim() || config.rpcUrl,
      chainId: profile?.chainId ?? config.chainId,
      address,
      fromBlock: bigintValue(eventSourceFromBlock, 'BUILDER_EVENT_EVM_FROM_BLOCK'),
      confirmations: integer(env.BUILDER_EVENT_EVM_CONFIRMATIONS, 2),
      maxBlockRange: bigintValue(env.BUILDER_EVENT_EVM_MAX_BLOCK_RANGE?.trim() || '2000', 'BUILDER_EVENT_EVM_MAX_BLOCK_RANGE'),
      maxReorgDepth: bigintValue(env.BUILDER_EVENT_EVM_MAX_REORG_DEPTH?.trim() || '128', 'BUILDER_EVENT_EVM_MAX_REORG_DEPTH'),
      ...(env.BUILDER_EVENT_EVM_TOPIC0?.trim() ? { topics: [env.BUILDER_EVENT_EVM_TOPIC0.trim()] } : {}),
    })) : [];
  if (eventWorkerEnabled && env.BUILDER_EVENT_MARKET_ENABLED === 'true') configuredEventSources.push(createKrakenMarketSource({
    intervalMs: integer(env.BUILDER_EVENT_MARKET_POLL_MS, 30000),
  }));

  const shutdown = new AbortController();
  const tasks = [];
  let started = false;
  const logError = (error) => {
    // Adapter errors can contain provider or RPC response bodies. Keep the
    // process log to a stable code so private input cannot escape here.
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'worker-error';
    console.error(JSON.stringify({ worker: 'builder', state: 'error', code }));
  };
  const startDesignWorker = () => {
    if (!designEnabled || !profile) return;
    const turns = createTurns(pool);
    const model = openAIModel({ apiKey: env.OPENAI_API_KEY, modelId: env.BUILDER_OPENAI_MODEL });
    const preparation = {
      simulationEnabled,
      walletEnabled: env.BUILDER_WALLET_ENABLED === 'true',
      eventUpdatesEnabled: eventWorkerEnabled && Boolean(configuredCreBridge || configuredEventGateway || dependencies.eventDelivery),
      outagePauseEnabled: eventWorkerEnabled && Boolean(configuredCreBridge),
      ...(inventoryEnabled ? { inventoryAdapter: nativeInventoryAdapter(profile, { rpcUrl: env.BUILDER_INVENTORY_RPC_URL || config.rpcUrl }) } : {}),
    };
    tasks.push((async () => {
      console.log(JSON.stringify({ worker: 'builder-design', state: 'ready' }));
      while (!shutdown.signal.aborted) {
        try {
          const turn = await turns.claim();
          if (turn) await runDesignTurn(pool, profile, model, turn, shutdown.signal, preparation);
          else await delay(integer(env.BUILDER_DESIGN_POLL_MS, 1000), undefined, { signal: shutdown.signal }).catch(() => {});
        } catch (error) {
          if (!shutdown.signal.aborted) { logError(error); await delay(5000, undefined, { signal: shutdown.signal }).catch(() => {}); }
        }
      }
    })().catch(logError));
  };
  const startSimulationWorker = async () => {
    if (!simulationEnabled) return;
    const { simulationMain } = await import('../../packages/builder-service/src/simulation-main.ts');
    tasks.push(simulationMain(shutdown.signal, env).catch(logError));
  };
  const startEventWorker = () => {
    if (!eventWorkerEnabled || !profile) return;
    // No default evaluator or broadcaster is installed. Running without an
    // explicitly injected adapter fails closed and never fabricates a Guard
    // report; queued work is retained with a stable failure state for review.
    const eventDependencies = dependencies.eventDelivery ?? configuredCreBridge ?? configuredEventGateway ?? {};
    tasks.push(runEventWorker(pool, profile, eventDependencies, {
      pollMs: integer(env.BUILDER_EVENT_POLL_MS, 1000),
      leaseMs: integer(env.BUILDER_EVENT_LEASE_MS, configuredCreBridge ? 300000 : 30000),
      signal: shutdown.signal,
      sources: dependencies.eventSources ?? configuredEventSources,
      ...(dependencies.outboxDispatch ? { outbox: dependencies.outboxDispatch } : {}),
      onError: logError,
    }).catch(logError));
  };
  return {
    enabled: true,
    pool,
    handler,
    async start() {
      if (started) return;
      started = true;
      startDesignWorker();
      await startSimulationWorker().catch(logError);
      startEventWorker();
    },
    async close() {
      if (!started) { shutdown.abort(); await pool.end(); return; }
      shutdown.abort();
      await Promise.race([Promise.allSettled(tasks), delay(5000)]);
      await pool.end();
    },
  };
}

function integer(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('invalid Builder worker timing');
  return result;
}

function bigintValue(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}
