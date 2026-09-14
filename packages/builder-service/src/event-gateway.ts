import { z } from 'zod'
import { sepoliaStandingProfile } from '@pintool/strategy-builder'
import { DeliveryNotSentError, type EventDeliveryDependencies, type EvaluationResult, type DeliveryReceipt, type DeliveryReconciliation } from './event-delivery.ts'
import { ServiceError } from './errors.ts'

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const owner = z.string().regex(/^wallet:0x[0-9a-fA-F]{40}$/)
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const nonce = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n)
const nonceFloor = z.union([z.literal('0'), nonce])
const date = z.string().datetime({ offset: true })
const jsonObject = z.record(z.string(), z.unknown())
const evaluationResponse = z.union([
  z.object({ status: z.literal('changed'), reportHash: hash, report: jsonObject, nonceFloor: nonceFloor.optional(), chainStateChanged: z.boolean().optional(), observedAt: date.optional() }).strict(),
  z.object({ status: z.enum(['unchanged', 'paused', 'failed']), reportHash: hash.optional(), report: jsonObject.optional(), reason: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/).optional(), observedAt: date.optional() }).strict(),
])
const receiptResponse = z.object({ transactionHash: hash, receipt: jsonObject.optional() }).strict()
const reconcileResponse = z.union([
  receiptResponse, z.null(),
  z.object({ status: z.literal('not-broadcast') }).strict(),
  z.object({ status: z.literal('reverted'), transactionHash: hash, receipt: jsonObject.optional() }).strict(),
])

export type EventGatewayOptions = {
  evaluatorUrl: string
  deliveryUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function endpoint(value: string, label: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${label} must be a URL`) }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error(`${label} must use HTTPS outside localhost`)
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`${label} cannot contain credentials or a fragment`)
  return parsed
}

function timeout(value: number | undefined) {
  const result = value ?? 120_000
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 600_000) throw new Error('event gateway timeout must be between 1000 and 600000')
  return result
}

function stableError(code: string) { return new ServiceError(code, 503) }

/**
 * HTTPS boundary for a deployment-owned TEE/CRE service. Only public identity,
 * artifact metadata and public events cross the evaluator boundary. The Maker
 * private policy remains in the evaluator's own confidential store.
 */
export function createHttpEventGateway(options: EventGatewayOptions): EventDeliveryDependencies {
  const evaluatorUrl = endpoint(options.evaluatorUrl, 'evaluatorUrl')
  const deliveryUrl = endpoint(options.deliveryUrl, 'deliveryUrl')
  if (!options.token || options.token.length > 4096) throw new Error('event gateway token is required')
  const timeoutMs = timeout(options.timeoutMs), fetchImpl = options.fetchImpl ?? fetch

  async function post(url: URL, payload: Record<string, unknown>) {
    let body: string
    try { body = JSON.stringify(payload) } catch { throw new DeliveryNotSentError('event-gateway-invalid-request', 400) }
    if (Buffer.byteLength(body) > 64_000) throw new DeliveryNotSentError('event-gateway-request-too-large', 400)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', accept: 'application/json' }, body, signal: controller.signal })
      } catch { throw stableError('event-gateway-unavailable') }
      if (!response.ok) throw stableError('event-gateway-rejected')
      const length = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(length) && length > 64_000) throw stableError('event-gateway-response-too-large')
      let value: unknown
      try {
        const text = await response.text()
        if (Buffer.byteLength(text) > 64_000) throw new Error('oversized')
        value = JSON.parse(text)
      } catch { throw stableError('event-gateway-invalid-response') }
      return value
    } finally { clearTimeout(timer) }
  }

  return {
    async evaluate(input) {
      const identity = input.binding ?? { ...input.artifact.payload, guard: input.artifact.payload.decoded.guard, router: sepoliaStandingProfile.router }
      // The HTTP gateway must authenticate this reference independently.
      const value = await post(evaluatorUrl, {
        schemaVersion: 1, operation: 'evaluate',
        owner: owner.parse(input.subscription.owner), draftId: input.subscription.draftId, revision: input.subscription.revision,
        artifactId: input.subscription.artifactId, consentId: input.subscription.consentId, generation: input.subscription.generation,
        strategyHash: hash.parse(identity.strategyHash), manifestHash: hash.parse(identity.manifestHash), contentDigest: hash.parse(identity.contentDigest),
        guard: address.parse(identity.guard), router: address.parse(identity.router), event: input.event,
      })
      return evaluationResponse.parse(value) as EvaluationResult
    },
    async deliver(input) {
      let payload: Record<string, unknown>
      try {
        payload = {
          schemaVersion: 1, operation: 'deliver', deliveryId: id.parse(input.deliveryId), owner: owner.parse(input.subscription.owner), subscriptionId: id.parse(input.subscription.id),
          draftId: id.parse(input.subscription.draftId), revision: input.subscription.revision, artifactId: id.parse(input.subscription.artifactId),
          generation: input.subscription.generation, reportHash: hash.parse(input.reportHash), nonce: nonce.parse(input.nonce), report: jsonObject.parse(input.report),
        }
      } catch { throw new DeliveryNotSentError('event-gateway-invalid-request', 400) }
      const value = await post(deliveryUrl, payload), parsed = receiptResponse.safeParse(value)
      if (!parsed.success) throw stableError('event-gateway-invalid-response')
      return parsed.data as DeliveryReceipt
    },
    async reconcile(input) {
      const value = await post(deliveryUrl, {
        schemaVersion: 1, operation: 'reconcile', deliveryId: id.parse(input.deliveryId), owner: owner.parse(input.subscription.owner),
        subscriptionId: id.parse(input.subscription.id), reportHash: hash.parse(input.reportHash), nonce: nonce.parse(input.nonce),
      })
      const parsed = reconcileResponse.safeParse(value)
      if (!parsed.success) throw stableError('event-gateway-invalid-response')
      return parsed.data as DeliveryReconciliation
    },
  }
}
