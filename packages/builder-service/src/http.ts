import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { ZodError, z } from 'zod'
import { DraftConflict, DraftAccessDenied, getCapabilities, sepoliaStandingProfile, validateStrategy, assessRequirements, assessRequirementCriteria } from '@pintool/strategy-builder'
import { createAuth } from './auth.ts'
import { createStore } from './store.ts'
import { ServiceError } from './errors.ts'
import { createTurns } from './turns.ts'
import { createPrivyVerifier } from './privy.ts'
import { createArtifacts } from './artifacts.ts'
import { createSimulations } from './simulations.ts'
import { createPreviews } from './previews.ts'
import { scenarioInputSchema } from 'aqua-executor/builder-preview'
import { createInventoryReader, type InventoryAdapter } from './inventory.ts'
import { createTemplates, type TemplateOptions } from './templates.ts'
import { createRequirementReviews } from './requirement-reviews.ts'
import { createTransactionPlans } from './transaction-plans.ts'
import { createAutomation } from './automation.ts'
import { createEventDelivery } from './event-delivery.ts'
import { createAuthorizationBindings, type BindingDependencies } from './bindings.ts'

const readJson = (request: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
  let size = 0, overflow = false
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 65536) { if (!overflow) reject(new ServiceError('request-too-large', 413)); overflow = true; chunks.length = 0; return }
    chunks.push(chunk)
  })
  request.on('end', () => {
    if (overflow) return
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new ServiceError('invalid-json')) }
  })
  request.on('error', () => reject(new ServiceError('request-interrupted')))
})

/** Mount under /v1/builder in the existing Node service. No request can submit system/tool history or an owner. */
export function builderHandler(pool: Pool, config: { origin: string; chainId: number; profileId: string; designEnabled?: boolean; simulationEnabled?: boolean; privyAppId?: string },
  dependencies: { verifyPrivy?: ReturnType<typeof createPrivyVerifier>; inventoryAdapter?: InventoryAdapter; templates?: Omit<TemplateOptions, 'origin'>; binding?: BindingDependencies } = {}) {
  const auth = createAuth(pool, config), store = createStore(pool, config.profileId), turns = createTurns(pool)
  const verifyPrivy = config.privyAppId ? dependencies.verifyPrivy ?? createPrivyVerifier(config.privyAppId) : undefined
  const artifacts = config.profileId === sepoliaStandingProfile.id ? createArtifacts(pool, sepoliaStandingProfile) : undefined
  const simulations = artifacts ? createSimulations(pool, sepoliaStandingProfile) : undefined
  const previews = artifacts ? createPreviews(pool, sepoliaStandingProfile) : undefined
  const inventory = artifacts && dependencies.inventoryAdapter ? createInventoryReader(pool, sepoliaStandingProfile, dependencies.inventoryAdapter) : undefined
  const templates = artifacts && dependencies.templates ? createTemplates(pool, sepoliaStandingProfile, { ...dependencies.templates, origin: config.origin }) : undefined
  const requirementReviews = artifacts ? createRequirementReviews(pool, sepoliaStandingProfile) : undefined
  const transactionPlans = artifacts ? createTransactionPlans(pool, sepoliaStandingProfile) : undefined
  const automation = artifacts ? createAutomation(pool, sepoliaStandingProfile) : undefined
  const events = artifacts ? createEventDelivery(pool, sepoliaStandingProfile) : undefined
  const bindings = artifacts ? createAuthorizationBindings(pool, sepoliaStandingProfile, dependencies.binding ?? {}) : undefined
  // Early protection for unauthenticated signature endpoints. No proxy headers are trusted.
  // Deployment ingress limits remain necessary across replicas; this is a bounded per-process limit.
  const attempts = new Map<string, { count: number; expires: number }>()
  function limit(request: IncomingMessage, budget: number) {
    const now = Date.now(), key = request.socket.remoteAddress ?? 'unknown'
    let entry = attempts.get(key)
    if (!entry || entry.expires <= now) {
      for (const [id, value] of attempts) if (value.expires <= now) attempts.delete(id)
      if (attempts.size >= 10000) throw new ServiceError('rate-limited', 429)
      entry = { count: 0, expires: now + 60000 }; attempts.set(key, entry)
    }
    if (++entry.count > budget) throw new ServiceError('rate-limited', 429)
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (!(request.url ?? '').startsWith('/v1/builder/')) return false
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/v1/builder/')) return false
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Access-Control-Allow-Origin', config.origin)
    response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,idempotency-key,x-privy-access-token')
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    response.setHeader('Vary', 'Origin')
    const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); return true }
    try {
      if (request.headers.origin && request.headers.origin !== config.origin) throw new ServiceError('origin-not-allowed', 403)
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true }
      if (!['GET', 'POST'].includes(request.method ?? '')) throw new ServiceError('method-not-allowed', 405)
      if (request.method === 'POST' && request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ServiceError('json-required', 415)
      const post = request.method === 'POST', route = url.pathname.slice('/v1/builder'.length)
      if (post && (route === '/auth/challenge' || route === '/auth/login')) limit(request, 60)
      const privyHeader = request.headers['x-privy-access-token']
      const identity = verifyPrivy ? await verifyPrivy(typeof privyHeader === 'string' ? privyHeader : undefined) : undefined
      if (post && (route === '/auth/challenge' || route === '/auth/login')) {
        return send(route === '/auth/challenge' ? await auth.challenge(await readJson(request), identity) : await auth.login(await readJson(request), identity))
      }
      const actor = await auth.authenticate(request.headers.authorization, identity)
      if (route === '/auth/session' && !post) return send({ actor })
      if (route === '/auth/logout' && post) return send(await auth.logout(request.headers.authorization))
      if (route === '/capabilities' && !post) return send({ profileId: config.profileId, capabilities: getCapabilities() })
      const requestId = request.headers['idempotency-key']
      if (post && (typeof requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(requestId))) throw new ServiceError('idempotency-key-required')
      const reviewConfirm = route.match(/^\/requirement-reviews\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/confirm$/)
      if (reviewConfirm && post) {
        if (!requirementReviews) throw new ServiceError('profile-unavailable', 503)
        const body = z.record(z.string(), z.unknown()).parse(await readJson(request))
        if ('reviewId' in body) throw new ServiceError('resource-id-in-body')
        return send(await requirementReviews.confirm(actor.owner, requestId as string, { ...body, reviewId: reviewConfirm[1] }))
      }
      const reviewDraft = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/requirement-review$/)
      if (reviewDraft) {
        if (!requirementReviews) throw new ServiceError('profile-unavailable', 503)
        if (!post) {
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1)
            throw new ServiceError('invalid-request')
          const expectedRevision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          return send(await requirementReviews.current(actor.owner, reviewDraft[1]!, expectedRevision))
        }
        const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await readJson(request))
        return send(await requirementReviews.prepare(actor.owner, requestId as string, { draftId: reviewDraft[1], ...body }))
      }
      const planRoute = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/(registration-plan|cancellation-plan)$/)
      if (planRoute && post) {
        if (!transactionPlans) throw new ServiceError('profile-unavailable', 503)
        const body = z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/) }).strict().parse(await readJson(request))
        const input = { draftId: planRoute[1], ...body }
        return send(planRoute[2] === 'registration-plan' ? await transactionPlans.prepareRegistration(actor.owner, requestId as string, input) : await transactionPlans.prepareCancellation(actor.owner, requestId as string, input))
      }
      const automationConfirm = route.match(/^\/automation-consents\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/(confirm|revoke)$/)
      if (automationConfirm && post) {
        if (!automation) throw new ServiceError('profile-unavailable', 503)
        const body = z.record(z.string(), z.unknown()).parse(await readJson(request))
        if ('intentId' in body || 'consentId' in body) throw new ServiceError('resource-id-in-body')
        if (automationConfirm[2] === 'confirm') {
          const value = z.object({ digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict().parse(body)
          return send(await automation.confirm(actor.owner, requestId as string, { intentId: automationConfirm[1], ...value }))
        }
        const value = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict().parse(body)
        return send(await automation.revoke(actor.owner, requestId as string, { consentId: automationConfirm[1], ...value }))
      }
      const automationDraft = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/automation-consent$/)
      if (automationDraft) {
        if (!automation) throw new ServiceError('profile-unavailable', 503)
        if (!post) {
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1)
            throw new ServiceError('invalid-request')
          const expectedRevision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          return send(await automation.current(actor.owner, automationDraft[1]!, expectedRevision))
        }
        const body = z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/) }).strict().parse(await readJson(request))
        return send(await automation.prepare(actor.owner, requestId as string, { draftId: automationDraft[1], ...body }))
      }
      const eventSubscriptionAction = route.match(/^\/event-subscriptions\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/stop$/)
      if (eventSubscriptionAction && post) {
        if (!events) throw new ServiceError('profile-unavailable', 503)
        const body = z.record(z.string(), z.unknown()).parse(await readJson(request))
        if ('subscriptionId' in body) throw new ServiceError('resource-id-in-body')
        z.object({}).strict().parse(body)
        return send(await events.stop(actor.owner, requestId as string, { subscriptionId: eventSubscriptionAction[1] }))
      }
      const eventSubscriptionDraft = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/event-subscription$/)
      if (eventSubscriptionDraft) {
        if (!events) throw new ServiceError('profile-unavailable', 503)
        if (!post) {
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1) throw new ServiceError('invalid-request')
          const expectedRevision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          return send(await events.current(actor.owner, eventSubscriptionDraft[1]!, expectedRevision))
        }
        const body = z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), consentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/) }).strict().parse(await readJson(request))
        return send(await events.enable(actor.owner, requestId as string, { draftId: eventSubscriptionDraft[1], ...body }))
      }
      const bindingConfirm = route.match(/^\/authorization-bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/confirm$/)
      if (bindingConfirm && post) {
        if (!bindings) throw new ServiceError('binding-proof-unavailable', 503)
        const body = z.record(z.string(), z.unknown()).parse(await readJson(request))
        if ('intentId' in body) throw new ServiceError('resource-id-in-body')
        const value = z.object({ digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130,132}$/) }).strict().parse(body)
        return send(await bindings.confirm(actor.owner, requestId as string, { intentId: bindingConfirm[1], ...value }))
      }
      const bindingDraft = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/authorization-binding$/)
      if (bindingDraft) {
        if (!bindings) throw new ServiceError('binding-proof-unavailable', 503)
        if (!post) {
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1) throw new ServiceError('invalid-request')
          const expectedRevision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          return send(await bindings.current(actor.owner, bindingDraft[1]!, expectedRevision))
        }
        const body = z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), reportDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/), reportTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), reportNonce: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().parse(await readJson(request))
        return send(await bindings.prepare(actor.owner, requestId as string, { draftId: bindingDraft[1], ...body }))
      }
      if (route === '/templates' || route === '/templates/prepare' || route === '/templates/publish' || route === '/templates/instantiate' || route === '/templates/withdraw') {
        if (!templates) throw new ServiceError('templates-unavailable', 503)
        limit(request, 120)
        if (route === '/templates' && !post) return send({ templates: await templates.list() })
        if (post && route !== '/templates') {
          const input = await readJson(request), key = requestId as string
          if (route === '/templates/prepare') return send(await templates.prepare(actor.owner, key, input))
          if (route === '/templates/publish') return send(await templates.publish(actor.owner, key, input))
          if (route === '/templates/withdraw') return send(await templates.withdraw(actor.owner, key, input))
          return send(await templates.instantiate(actor.owner, key, input))
        }
      }
      const templateVersion = route.match(/^\/templates\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/versions\/([1-9][0-9]{0,15})$/)
      if (templateVersion && !post) {
        if (!templates) throw new ServiceError('templates-unavailable', 503)
        return send(await templates.get(templateVersion[1]!, Number(templateVersion[2])))
      }
      if (route === '/conversations') return send(post ? await store.create(actor.owner, requestId as string, await readJson(request)) : { conversations: await store.list(actor.owner) })
      const newTurn = route.match(/^\/conversations\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/turns$/)
      if (newTurn && post) {
        if (!config.designEnabled) throw new ServiceError('design-unavailable', 503)
        const body = z.object({ content: z.string(), expectedRevision: z.number() }).strict().parse(await readJson(request))
        return send(await turns.accept(actor.owner, requestId as string, { ...body, conversationId: newTurn[1] }), 202)
      }
      const turn = route.match(/^\/turns\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})(\/(events|cancel))?$/)
      if (turn) {
        if (!post && !turn[2]) return send({ turn: await turns.get(actor.owner, turn[1]!) })
        if (!post && turn[3] === 'events') return send({ events: await turns.events(actor.owner, turn[1]!, url.searchParams.get('after') ?? '0') })
        if (post && turn[3] === 'cancel') {
          z.object({}).strict().parse(await readJson(request))
          return send(await turns.cancel(actor.owner, turn[1]!))
        }
      }
      const simulation = route.match(/^\/simulations\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})(\/cancel)?$/)
      if (simulation) {
        if (!simulations) throw new ServiceError('profile-unavailable', 503)
        if (!post && !simulation[2]) return send(await simulations.get(actor.owner, simulation[1]!))
        if (post && simulation[2]) {
          z.object({}).strict().parse(await readJson(request))
          return send(await simulations.cancel(actor.owner, requestId as string, simulation[1]!))
        }
      }
      const artifact = route.match(/^\/artifacts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})(\/simulations)?$/)
      if (artifact && !post) {
        if (!artifacts) throw new ServiceError('profile-unavailable', 503)
        if (!artifact[2]) return send(await artifacts.get(actor.owner, artifact[1]!))
      }
      if (artifact?.[2] && post) {
        if (!artifacts || !simulations) throw new ServiceError('profile-unavailable', 503)
        if (!config.simulationEnabled) throw new ServiceError('simulation-unavailable', 503)
        const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await readJson(request))
        const owned = await artifacts.get(actor.owner, artifact[1]!)
        return send(await simulations.start(actor.owner, requestId as string, { artifactId: artifact[1], draftId: owned.payload.draftId, ...body }), 202)
      }
      const preview = route.match(/^\/previews\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})$/)
      if (preview && !post) {
        if (!previews) throw new ServiceError('profile-unavailable', 503)
        return send(await previews.get(actor.owner, preview[1]!))
      }
      const draft = route.match(/^\/drafts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})(\/(history|patch|restore|validation|compile|artifacts|simulations|previews|inventory|template-context))?$/)
      if (draft) {
        if (!post && !draft[2]) return send({ draft: await store.get(actor.owner, draft[1]!) })
        if (!post && draft[3] === 'template-context') {
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1) throw new ServiceError('invalid-request')
          const revision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          return send({ context: await store.templateContext(actor.owner, draft[1]!, revision) })
        }
        if (!post && draft[3] === 'inventory') {
          if (!inventory) throw new ServiceError('inventory-unavailable', 503)
          if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1) throw new ServiceError('invalid-request')
          const expectedRevision = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('revision'))
          limit(request, 120)
          return send(await inventory.read(actor.owner, { draftId: draft[1], expectedRevision }))
        }
        if (draft[3] === 'previews') {
          if (!previews) throw new ServiceError('profile-unavailable', 503)
          if (!post) return send({ previews: await previews.list(actor.owner, draft[1]!) })
          const input = scenarioInputSchema.extend({ expectedRevision: z.number().int().positive() }).strict().parse(await readJson(request))
          return send(await previews.preview(actor.owner, requestId as string, { draftId: draft[1], ...input }))
        }
        if (!post && draft[3] === 'simulations') {
          if (!simulations) throw new ServiceError('profile-unavailable', 503)
          return send({ simulations: await simulations.list(actor.owner, draft[1]!) })
        }
        if ((post && draft[3] === 'compile') || (!post && draft[3] === 'artifacts')) {
          if (!artifacts) throw new ServiceError('profile-unavailable', 503)
          if (!post) return send({ artifacts: await artifacts.list(actor.owner, draft[1]!) })
          const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await readJson(request))
          return send(await artifacts.compile(actor.owner, requestId as string, { draftId: draft[1], ...body }))
        }
        if (!post && draft[3] === 'validation') {
          const current = await store.get(actor.owner, draft[1]!)
          if (config.profileId !== sepoliaStandingProfile.id) throw new ServiceError('profile-unavailable', 503)
          const result = validateStrategy(current, sepoliaStandingProfile, Math.floor(Date.now() / 1000))
          return send({ revision: current.revision, ready: result.ready, errors: result.errors,
            missingFields: result.missingFields, requirements: assessRequirements(current), requirementAssessment: assessRequirementCriteria(current) })
        }
        if (!post && draft[3] === 'history') return send({ revisions: await store.history(actor.owner, draft[1]!) })
        if (post && ['patch', 'restore'].includes(draft[3]!)) {
          const body = z.record(z.string(), z.unknown()).parse(await readJson(request))
          if ('draftId' in body) throw new ServiceError('resource-id-in-body')
          const value = { ...body, draftId: draft[1] }
          return send(draft[3] === 'patch' ? await store.patch(actor.owner, requestId as string, value) : await store.restore(actor.owner, requestId as string, value))
        }
      }
      const messages = route.match(/^\/conversations\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})\/messages$/)
      if (messages) {
        if (!post) return send({ messages: await store.messages(actor.owner, messages[1]!, url.searchParams.get('before') ?? undefined) })
        const body = z.object({ content: z.string() }).strict().parse(await readJson(request))
        return send(await store.appendUserMessage(actor.owner, requestId as string, { ...body, conversationId: messages[1] }))
      }
      throw new ServiceError('not-found', 404)
    } catch (error) {
      if (error instanceof ServiceError) return send({ error: error.code }, error.status)
      if (error instanceof DraftConflict) return send({ error: 'revision-or-template-conflict' }, 409)
      if (error instanceof DraftAccessDenied) return send({ error: 'not-found' }, 404)
      if (error instanceof ZodError) return send({ error: 'invalid-request' }, 400)
      // PostgreSQL errors may contain input values, and driver errors may contain credentials.
      return send({ error: 'builder-unavailable' }, 503)
    }
  }
}
