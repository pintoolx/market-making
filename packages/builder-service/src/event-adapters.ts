import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { z } from 'zod'
import { parsePublicEvent, type PublicEvent } from './event-delivery.ts'

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const source = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const eventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const observedAt = z.string().datetime({ offset: true })

/** A source adapter returns only public, revision-independent events. */
export type EventSource = {
  source: string
  poll(signal: AbortSignal): Promise<{ events: unknown[]; cursor?: Record<string, unknown>; observedAt?: string }>
}

export type EventIngress = {
  verify(input: { headers: IncomingHttpHeaders; body: unknown }): unknown
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function header(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Verify the short-lived signature used by a deployed event gateway. The
 * secret is held by the gateway and never included in an event or a report.
 */
export function createSignedEventIngress(secret: string, options: { maxAgeSeconds?: number; clock?: () => number } = {}): EventIngress & { sign(body: unknown, timestamp?: number): string } {
  if (!secret) throw new Error('event ingress secret is required')
  const maxAge = options.maxAgeSeconds ?? 300
  if (!Number.isInteger(maxAge) || maxAge < 30 || maxAge > 3600) throw new Error('invalid event ingress max age')
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000))
  const digest = (timestamp: string, body: unknown) => createHmac('sha256', secret).update(`${timestamp}.${stable(body)}`).digest('hex')
  return {
    verify({ headers, body }) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('event body must be an object')
      const timestamp = header(headers, 'x-pintool-event-timestamp')
      const signature = header(headers, 'x-pintool-event-signature')
      if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) throw new Error('event signature missing')
      const seconds = Number(timestamp), now = clock()
      if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) > maxAge) throw new Error('event signature expired')
      const expected = Buffer.from(`sha256=${digest(timestamp, body)}`), actual = Buffer.from(signature)
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('event signature invalid')
      return body
    },
    sign(body, timestamp = clock()) {
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid event timestamp')
      const value = String(timestamp)
      return `sha256=${digest(value, body)}`
    },
  }
}

const marketInput = z.object({
  eventId, price: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/), observedAt,
  bid: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).optional(), ask: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).optional(),
  volume: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).optional(),
}).strict()

/** Normalize an upstream market update without treating it as authorization. */
export function normalizeMarketUpdate(sourceName: string, input: unknown): PublicEvent {
  source.parse(sourceName)
  const value = marketInput.parse(input)
  const { eventId: id, observedAt: seen, ...payload } = value
  return parsePublicEvent({ source: sourceName, eventId: id, kind: 'market.updated', payload, observedAt: seen })
}

const evmInput = z.object({
  eventId: eventId.optional(), chainId: z.number().int().positive(), blockNumber: z.string().regex(/^[0-9]+$/), blockHash: hash,
  transactionHash: hash, logIndex: z.number().int().nonnegative(), address, topics: z.array(hash).max(16), data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/).optional(), observedAt,
}).strict()

/** Normalize an EVM log with the complete identity needed for reorg handling. */
export function normalizeEvmLog(sourceName: string, input: unknown): PublicEvent {
  source.parse(sourceName)
  const value = evmInput.parse(input)
  const id = value.eventId ?? `${value.transactionHash}:${value.logIndex}`
  return parsePublicEvent({ source: sourceName, eventId: id, kind: value.kind ?? 'evm.log', observedAt: value.observedAt,
    chainId: value.chainId, blockNumber: value.blockNumber, blockHash: value.blockHash, transactionHash: value.transactionHash, logIndex: value.logIndex,
    payload: { address: value.address, topics: value.topics, data: value.data } })
}
