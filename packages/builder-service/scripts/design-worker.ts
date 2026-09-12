import { setTimeout as delay } from 'node:timers/promises'
import { sepoliaStandingProfile } from '@pintool/strategy-builder'
import { database, createTurns, runDesignTurn, openAIModel, nativeInventoryAdapter } from '../src/index.ts'

// Run migrations before starting the API and worker. Environment is consumed, never printed.
const shutdown = new AbortController()
process.once('SIGTERM', () => shutdown.abort())
process.once('SIGINT', () => shutdown.abort())
let pool: ReturnType<typeof database> | undefined
try {
  const model = openAIModel({ apiKey: process.env.OPENAI_API_KEY ?? '', modelId: process.env.BUILDER_OPENAI_MODEL })
  pool = database(process.env.DATABASE_URL ?? '')
  await pool.query('SELECT id FROM builder.agent_turns LIMIT 0')
  const turns = createTurns(pool)
  const preparation = {
    simulationEnabled: process.env.BUILDER_SIMULATION_ENABLED === 'true',
    ...(process.env.BUILDER_INVENTORY_ENABLED === 'true' ? { inventoryAdapter: nativeInventoryAdapter(sepoliaStandingProfile,
      { rpcUrl: process.env.BUILDER_INVENTORY_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' }) } : {}),
  }
  console.log(JSON.stringify({ worker: 'builder-design', state: 'ready' }))
  while (!shutdown.signal.aborted) {
    const turn = await turns.claim()
    if (turn) await runDesignTurn(pool, sepoliaStandingProfile, model, turn, shutdown.signal, preparation)
    else await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {})
  }
} catch {
  console.error(JSON.stringify({ worker: 'builder-design', state: 'unavailable' }))
  process.exitCode = 1
} finally { await pool?.end() }
