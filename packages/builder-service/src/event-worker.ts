import type { Pool } from 'pg'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import { createEventDelivery, type EventDeliveryDependencies } from './event-delivery.ts'
import type { EventSource } from './event-adapters.ts'
import { createOutboxDispatcher, type OutboxEntry } from './outbox.ts'

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

export type EventWorkerOptions = { pollMs?: number; leaseMs?: number; signal?: AbortSignal; onError?: (error: unknown) => void; sources?: EventSource[]; outbox?: (entry: OutboxEntry) => Promise<void> }

/**
 * Long-lived event worker. Browser requests only enqueue public events; this
 * loop owns leases, evaluates one generation at a time and delivers pending
 * reports. It never receives a Maker private key or signs asset transactions.
 */
export async function runEventWorker(pool: Pool, profile: DeploymentProfile, dependencies: EventDeliveryDependencies, options: EventWorkerOptions = {}) {
  const pollMs = options.pollMs ?? 1000, leaseMs = options.leaseMs ?? 30000, signal = options.signal ?? new AbortController().signal
  if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 60000 || !Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) throw new Error('invalid event worker timing')
  const service = createEventDelivery(pool, profile, dependencies)
  const outbox = options.outbox ? createOutboxDispatcher(pool, options.outbox, { leaseMs }) : null
  const sources = options.sources ?? [], sourceHealth = new Map<string, 'healthy' | 'error'>(), sourceCursors = new Map<string, Record<string, unknown> | undefined>(), initializedSources = new Set<string>()
  let nextSourcePoll = 0
  while (!signal.aborted) {
    let worked = false
    if (sources.length && Date.now() >= nextSourcePoll) {
      nextSourcePoll = Date.now() + pollMs
      for (const source of sources) {
        try {
          if (!initializedSources.has(source.source)) {
            const saved = await service.cursor(source.source)
            sourceCursors.set(source.source, saved?.cursor)
            initializedSources.add(source.source)
          }
          const batch = await source.poll(signal, sourceCursors.get(source.source))
          for (const eventId of batch.reorgedEventIds ?? []) await service.markReorg(source.source, eventId)
          for (const event of batch.events) { if (signal.aborted) break; await service.ingest(event) }
          const health = sourceHealth.get(source.source) === 'error' ? 'recovered' : 'healthy'
          await service.health(source.source, { chainId: batch.chainId, cursor: batch.cursor ?? {}, blockHash: batch.blockHash, observedAt: batch.observedAt ?? new Date().toISOString(), health })
          sourceCursors.set(source.source, batch.cursor ?? sourceCursors.get(source.source) ?? {})
          sourceHealth.set(source.source, 'healthy')
          worked ||= batch.events.length > 0
        } catch (error) {
          if (signal.aborted) break
          sourceHealth.set(source.source, 'error')
          options.onError?.(error)
          try { await service.health(source.source, { cursor: sourceCursors.get(source.source) ?? {}, observedAt: new Date().toISOString(), health: 'error', errorCode: 'source-unavailable' }) }
          catch (healthError) { options.onError?.(healthError) }
        }
      }
    }
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
      // A process can stop after the adapter has broadcast a report but before
      // the receipt is persisted. Reconcile those rows after restart; never
      // call deliver again for a row already marked broadcast.
      if (dependencies.reconcile) {
        for (const id of await service.broadcastDeliveries()) {
          try {
            const result = await service.reconcile(id)
            worked ||= result.status === 'accepted'
          } catch (error) { options.onError?.(error) }
        }
      }
      if (outbox) {
        const delivered = await outbox.process(20, (error) => options.onError?.(error))
        worked ||= delivered > 0
      }
    } catch (error) { options.onError?.(error) }
    if (!worked) await wait(pollMs, signal)
  }
}
