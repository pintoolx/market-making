import { setTimeout as delay } from 'node:timers/promises';
import { sepoliaStandingProfile } from '../../packages/strategy-builder/src/index.ts';

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
  } = await import('../../packages/builder-service/src/index.ts');
  const { createSignedEventIngress } = await import('../../packages/builder-service/src/event-adapters.ts');

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
  const handler = builderHandler(pool, {
    origin: config.allowedOrigin,
    chainId: config.chainId,
    profileId,
    designEnabled,
    simulationEnabled,
    ...(env.PRIVY_APP_ID ? { privyAppId: env.PRIVY_APP_ID } : {}),
  }, {
    ...(inventoryEnabled && profile ? {
      inventoryAdapter: nativeInventoryAdapter(profile, {
        rpcUrl: env.BUILDER_INVENTORY_RPC_URL || config.rpcUrl,
      }),
    } : {}),
    ...(templatesKey && profile ? {
      templates: { workflowPublicKey: templatesKey, price: krakenTemplatePrice },
    } : {}),
    ...(eventIngress ? { eventIngress } : {}),
  });

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
    const eventDependencies = dependencies.eventDelivery ?? {};
    tasks.push(runEventWorker(pool, profile, eventDependencies, {
      pollMs: integer(env.BUILDER_EVENT_POLL_MS, 1000),
      leaseMs: integer(env.BUILDER_EVENT_LEASE_MS, 30000),
      signal: shutdown.signal,
      ...(dependencies.eventSources ? { sources: dependencies.eventSources } : {}),
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
