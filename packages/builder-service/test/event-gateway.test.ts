import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpEventGateway } from '../src/index.ts'

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`
const snapshot = {
  subscription: { id: 'subscription-1', owner: 'wallet:0x1111111111111111111111111111111111111111', draftId: 'draft-1', revision: 4, artifactId: 'artifact-1', consentId: 'consent-1', generation: 2, state: 'enabled' as const, lastEventAt: null, lastInputObservedAt: null, lastEvaluatedAt: null, lastChangedAt: null, lastReportHash: null, lastReportNonce: null, stoppedAt: null },
  event: { source: 'market.gateway', eventId: 'event-1', kind: 'market.updated', payload: { price: '2500' }, observedAt: '2026-09-13T00:00:00.000Z' },
  binding: { strategyHash: hash('a'), manifestHash: hash('b'), contentDigest: hash('c'), guard: '0x2222222222222222222222222222222222222222', router: '0x3333333333333333333333333333333333333333' },
  draft: {}, artifact: {}, consent: {},
}

test('HTTP event gateway sends only public identity and strictly validates delivery responses', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const responses = [
    { status: 'changed', reportHash: hash('d'), report: { allowedDirections: 3 }, observedAt: snapshot.event.observedAt },
    { transactionHash: hash('e'), receipt: { status: 'accepted' } },
    null,
  ]
  const gateway = createHttpEventGateway({ evaluatorUrl: 'https://tee.example/evaluate', deliveryUrl: 'https://tee.example/deliver', token: 'gateway-secret', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init: init! })
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const evaluated = await gateway.evaluate!(snapshot as never)
  assert.deepEqual(evaluated, { status: 'changed', reportHash: hash('d'), report: { allowedDirections: 3 }, observedAt: snapshot.event.observedAt })
  const sent = JSON.parse(String(calls[0]!.init.body))
  assert.equal(sent.operation, 'evaluate'); assert.equal(sent.owner, snapshot.subscription.owner); assert.deepEqual(sent.event, snapshot.event)
  assert.equal('draft' in sent, false); assert.equal('consent' in sent, false); assert.equal(calls[0]!.init.headers && (calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer gateway-secret')
  const receipt = await gateway.deliver!({ subscription: snapshot.subscription as never, report: { allowedDirections: 3 }, reportHash: hash('d'), nonce: '7' })
  assert.equal(receipt.transactionHash, hash('e'))
  assert.equal((await gateway.reconcile!({ deliveryId: 'delivery-1', subscription: snapshot.subscription as never, reportHash: hash('d'), nonce: '7' })), null)
})

test('HTTP event gateway rejects unsafe endpoints, partial responses and invalid receipts', async () => {
  assert.throws(() => createHttpEventGateway({ evaluatorUrl: 'http://tee.example/evaluate', deliveryUrl: 'https://tee.example/deliver', token: 'x' }), /HTTPS/)
  assert.throws(() => createHttpEventGateway({ evaluatorUrl: 'https://tee.example/evaluate', deliveryUrl: 'https://tee.example/deliver', token: '' }), /token/)
  const gateway = createHttpEventGateway({ evaluatorUrl: 'https://tee.example/evaluate', deliveryUrl: 'https://tee.example/deliver', token: 'x', fetchImpl: async () => new Response(JSON.stringify({ status: 'changed', report: {} }), { status: 200 }) })
  await assert.rejects(gateway.evaluate!(snapshot as never), /event-gateway-invalid-response|Invalid input/)
  const failed = createHttpEventGateway({ evaluatorUrl: 'https://tee.example/evaluate', deliveryUrl: 'https://tee.example/deliver', token: 'x', fetchImpl: async () => new Response(JSON.stringify({ transactionHash: hash('a'), receipt: null }), { status: 200 }) })
  await assert.rejects(failed.deliver!({ subscription: snapshot.subscription as never, report: {}, reportHash: hash('a'), nonce: '1' }), /Invalid input/)
})
