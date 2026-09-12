import type { Pool } from 'pg'
import { simulateBuilderLifecycle } from 'aqua-executor/builder-simulation'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import { createSimulations, parseSimulationReport, type ClaimedSimulation, type SimulationReport } from './simulations.ts'

type Inputs = Awaited<ReturnType<ReturnType<typeof createSimulations>['input']>>
export type SimulationAdapter = (input: Inputs, signal: AbortSignal) => Promise<SimulationReport>

/** Constructed from operator configuration, never from an agent's tool arguments or a request body. */
export const forkSimulationAdapter = (profile: DeploymentProfile, options: Omit<Parameters<typeof simulateBuilderLifecycle>[3], 'signal'>): SimulationAdapter =>
  async (input, signal) => parseSimulationReport(await simulateBuilderLifecycle(input.draft, input.compilation, profile, { ...options, signal }))

/** One bounded background job; an HTTP connection never owns its process lifetime. */
export async function runSimulation(pool: Pool, profile: DeploymentProfile, adapter: SimulationAdapter, claim: ClaimedSimulation, signal?: AbortSignal) {
  const simulations = createSimulations(pool, profile), abort = new AbortController()
  const combined = AbortSignal.any([abort.signal, AbortSignal.timeout(320000), ...(signal ? [signal] : [])])
  let busy = false
  const heartbeat = setInterval(async () => {
    if (busy) return
    busy = true
    try { await simulations.heartbeat(claim) } catch { abort.abort() } finally { busy = false }
  }, 10000)
  heartbeat.unref()
  try {
    if (combined.aborted) throw new Error('simulation-interrupted')
    const input = await simulations.input(claim)
    const report = await adapter(input, combined)
    if (combined.aborted) throw new Error('simulation-interrupted')
    return await simulations.finish(claim, report)
  } catch {
    abort.abort()
    // Process shutdown lets the persisted lease expire. Cancelled/stale/reclaimed jobs cannot publish.
    if (!signal?.aborted) { try { await simulations.fail(claim) } catch { /* authority lost */ } }
    return { state: 'incomplete' as const }
  } finally { clearInterval(heartbeat) }
}
