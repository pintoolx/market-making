import type { Pool } from 'pg'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import { createEventDelivery, type EventDeliveryDependencies } from './event-delivery.ts'

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

export type EventWorkerOptions = { pollMs?: number; leaseMs?: number; signal?: AbortSignal; onError?: (error: unknown) => void }

/**
 * Long-lived event worker. Browser requests only enqueue public events; this
 * loop owns leases, evaluates one generation at a time and delivers pending
 * reports. It never receives a Maker private key or signs asset transactions.
 */
export async function runEventWorker(pool: Pool, profile: DeploymentProfile, dependencies: EventDeliveryDependencies, options: EventWorkerOptions = {}) {
  const pollMs = options.pollMs ?? 1000, leaseMs = options.leaseMs ?? 30000, signal = options.signal ?? new AbortController().signal
  if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 60000 || !Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) throw new Error('invalid event worker timing')
  const service = createEventDelivery(pool, profile, dependencies)
  while (!signal.aborted) {
    let worked = false
    try {
      const job = await service.claimEvaluation(leaseMs)
      if (job) {
        worked = true
        const result = await service.evaluate(job.id, job.token)
        if (result.deliveryId) {
          try { await service.deliver(result.deliveryId) } catch (error) { options.onError?.(error) }
        }
      }
      for (const id of await service.pendingDeliveries()) {
        worked = true
        try { await service.deliver(id) } catch (error) { options.onError?.(error) }
      }
    } catch (error) { options.onError?.(error) }
    if (!worked) await wait(pollMs, signal)
  }
}
