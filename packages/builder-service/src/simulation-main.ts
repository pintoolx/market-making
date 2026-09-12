import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { database } from './database.ts'
import { createSimulations } from './simulations.ts'
import { forkSimulationAdapter, runSimulation } from './simulation-worker.ts'

/** Dedicated process, one owned fork at a time. Startup does not run privileged migrations. */
export async function simulationMain(signal: AbortSignal) {
  if (process.env.BUILDER_SIMULATION_ENABLED !== 'true') throw new Error('simulation-worker-disabled')
  const pool = database(process.env.DATABASE_URL ?? '')
  try {
    const schema = await pool.query("SELECT name FROM builder.schema_migrations WHERE name='005_simulation_runs.sql'")
    if (schema.rowCount !== 1) throw new Error('simulation-migration-required')
    const simulations = createSimulations(pool, profile), adapter = forkSimulationAdapter(profile, {
      rpcUrl: process.env.BUILDER_SIMULATION_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', anvil: process.env.ANVIL,
    })
    console.log(JSON.stringify({ event: 'simulation-worker-started', profileId: profile.id }))
    while (!signal.aborted) {
      try {
        const claim = await simulations.claim()
        if (claim) {
          const outcome = await runSimulation(pool, profile, adapter, claim, signal)
          console.log(JSON.stringify({ event: 'simulation-job-finished', id: claim.id, attempt: claim.attempt, state: outcome.state }))
        } else await delay(1000, undefined, { signal })
      } catch {
        if (!signal.aborted) {
          console.error('Simulation worker temporarily unavailable; retrying without provider details.')
          await delay(5000, undefined, { signal }).catch(() => {})
        }
      }
    }
  } finally { await pool.end() }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(), stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try { await simulationMain(abort.signal) }
  catch { console.error('Simulation worker startup failed; verify configuration and applied migrations.'); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
