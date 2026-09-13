import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { z } from 'zod'
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { parsePublicEvent, type PublicEvent } from './event-delivery.ts'

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const source = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const eventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const observedAt = z.string().datetime({ offset: true })

export type EventSourceBatch = {
  events: unknown[]
  cursor?: Record<string, unknown>
  observedAt?: string
  chainId?: number
  blockHash?: `0x${string}`
  /** Existing inbox identities that disappeared during a detected reorg. */
  reorgedEventIds?: string[]
}

/** A source adapter returns only public, revision-independent events. */
export type EventSource = {
  source: string
  poll(signal: AbortSignal, cursor?: Record<string, unknown>): Promise<EventSourceBatch>
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

type EvmLogRecord = {
  address: Address
  topics: readonly Hex[]
  data: Hex
  blockNumber?: bigint
  blockHash?: Hex
  transactionHash?: Hex
  logIndex?: number | bigint
}

type EvmLogReader = {
  getBlockNumber(): Promise<bigint>
  getBlock(input: { blockNumber: bigint }): Promise<{ hash?: Hex } | null>
  getLogs(input: { address: Address; topics?: readonly unknown[]; fromBlock: bigint; toBlock: bigint }): Promise<readonly EvmLogRecord[]>
}

type EvmHistoryEntry = { blockNumber: string; blockHash: `0x${string}`; eventIds: string[] }
const evmCursor = z.object({
  nextBlock: z.string().regex(/^[0-9]+$/),
  headBlock: z.string().regex(/^[0-9]+$/).optional(),
  headHash: hash.optional(),
  history: z.array(z.object({ blockNumber: z.string().regex(/^[0-9]+$/), blockHash: hash, eventIds: z.array(eventId) }).strict()).max(256).optional(),
}).strict()

export type EvmLogSourceOptions = {
  source: string
  rpcUrl: string
  chainId: number
  address: Address
  topics?: readonly unknown[]
  fromBlock: bigint
  confirmations?: number
  maxBlockRange?: bigint
  maxReorgDepth?: bigint
  kind?: string
  clock?: () => Date
  /** Injectable reader keeps source tests deterministic; production uses viem over HTTPS. */
  reader?: EvmLogReader
}

function sourceUrl(value: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('rpcUrl must be a URL') }
  if (parsed.protocol !== 'https:' && !(parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') || parsed.username || parsed.password || parsed.hash) throw new Error('rpcUrl must be HTTPS without credentials')
  return parsed.toString()
}

function positiveBigInt(value: bigint, label: string) {
  if (value < 1n) throw new Error(`${label} must be positive`)
  return value
}

/**
 * Poll a confirmed EVM log range with a durable cursor. The cursor contains a
 * bounded set of event-bearing block hashes; if one changes, the source emits
 * the old identities for inbox cancellation and replays the affected range.
 * It never treats an unconfirmed head as an authorization input.
 */
export function createEvmLogSource(options: EvmLogSourceOptions): EventSource {
  source.parse(options.source)
  const rpcUrl = sourceUrl(options.rpcUrl)
  if (!Number.isSafeInteger(options.chainId) || options.chainId < 1) throw new Error('chainId must be positive')
  address.parse(options.address)
  if (options.fromBlock < 0n) throw new Error('fromBlock must be non-negative')
  const confirmations = options.confirmations ?? 2
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 256) throw new Error('confirmations must be between 0 and 256')
  const maxBlockRange = positiveBigInt(options.maxBlockRange ?? 2_000n, 'maxBlockRange')
  const maxReorgDepth = positiveBigInt(options.maxReorgDepth ?? 128n, 'maxReorgDepth')
  if (maxReorgDepth > 256n) throw new Error('maxReorgDepth must be at most 256')
  const topicSchema = z.union([hash, z.array(hash).max(256), z.null()])
  const topics = options.topics === undefined ? undefined : z.array(topicSchema).max(4).parse(options.topics)
  const kind = options.kind ?? 'evm.log'
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(kind)) throw new Error('kind is invalid')
  const clock = options.clock ?? (() => new Date())
  const reader: EvmLogReader = options.reader ?? (() => {
    const client = createPublicClient({ transport: http(rpcUrl) })
    return {
      getBlockNumber: () => client.getBlockNumber(),
      getBlock: ({ blockNumber }) => client.getBlock({ blockNumber }).then(block => ({ hash: block.hash })),
      getLogs: input => client.getLogs(input as never) as Promise<readonly EvmLogRecord[]>,
    }
  })()

  return {
    source: options.source,
    async poll(signal, savedCursor) {
      if (signal.aborted) return { events: [] }
      const parsed = savedCursor ? evmCursor.parse(savedCursor) : { nextBlock: options.fromBlock.toString(), history: [] as EvmHistoryEntry[] }
      let nextBlock = BigInt(parsed.nextBlock)
      let history = (parsed.history ?? []) as EvmHistoryEntry[]
      const head = await reader.getBlockNumber()
      const safeHead = head - BigInt(confirmations)
      if (safeHead < 0n) return { events: [], chainId: options.chainId, observedAt: clock().toISOString(), cursor: { ...parsed, nextBlock: nextBlock.toString(), history } }

      const headBlock = await reader.getBlock({ blockNumber: safeHead })
      if (!headBlock?.hash) throw new Error('rpc returned a block without hash')
      const reorged = new Set<string>(), divergent = new Set<string>()
      // Checking the bounded history every poll catches a reorg even when the
      // provider has already advanced beyond the block that changed.
      for (const entry of history) {
        const blockNumber = BigInt(entry.blockNumber)
        if (blockNumber > safeHead) continue
        const current = await reader.getBlock({ blockNumber })
        if (!current?.hash) throw new Error('rpc returned a block without hash')
        if (current.hash.toLowerCase() !== entry.blockHash.toLowerCase()) {
          divergent.add(entry.blockNumber)
          for (const id of entry.eventIds) reorged.add(id)
        }
      }
      if (divergent.size) {
        const first = [...divergent].map(value => BigInt(value)).reduce((a, b) => a < b ? a : b)
        nextBlock = nextBlock < first ? nextBlock : first
        history = history.filter(entry => BigInt(entry.blockNumber) < first)
      }

      const events: PublicEvent[] = []
      while (nextBlock <= safeHead) {
        if (signal.aborted) return { events, chainId: options.chainId, blockHash: headBlock.hash, observedAt: clock().toISOString(), cursor: { nextBlock: nextBlock.toString(), headBlock: safeHead.toString(), headHash: headBlock.hash, history }, reorgedEventIds: [...reorged] }
        const toBlock = nextBlock + maxBlockRange - 1n < safeHead ? nextBlock + maxBlockRange - 1n : safeHead
        const logs = await reader.getLogs({ address: options.address, topics, fromBlock: nextBlock, toBlock })
        const grouped = new Map<string, EvmHistoryEntry>()
        for (const log of logs) {
          if (log.blockNumber === undefined || log.blockHash === undefined || log.transactionHash === undefined || log.logIndex === undefined) throw new Error('rpc returned an incomplete log')
          const logIndex = typeof log.logIndex === 'bigint' ? Number(log.logIndex) : log.logIndex
          if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new Error('rpc returned an invalid log index')
          const event = normalizeEvmLog(options.source, { chainId: options.chainId, blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex, address: log.address, topics: [...log.topics], data: log.data, kind, observedAt: clock().toISOString() })
          events.push(event)
          const blockNumber = log.blockNumber.toString(), key = `${blockNumber}:${log.blockHash.toLowerCase()}`
          const current = grouped.get(key) ?? { blockNumber, blockHash: log.blockHash, eventIds: [] }
          current.eventIds.push(event.eventId); grouped.set(key, current)
        }
        history.push(...grouped.values())
        nextBlock = toBlock + 1n
      }
      history = [...new Map(history.map(entry => [`${entry.blockNumber}:${entry.blockHash.toLowerCase()}`, entry])).values()]
        .filter(entry => BigInt(entry.blockNumber) >= safeHead - maxReorgDepth)
        .slice(-256)
      events.sort((a, b) => Number(BigInt(a.blockNumber ?? '0') - BigInt(b.blockNumber ?? '0')) || (a.logIndex ?? 0) - (b.logIndex ?? 0))
      return { events, chainId: options.chainId, blockHash: headBlock.hash, observedAt: clock().toISOString(), reorgedEventIds: [...reorged], cursor: { nextBlock: nextBlock.toString(), headBlock: safeHead.toString(), headHash: headBlock.hash, history } }
    },
  }
}
