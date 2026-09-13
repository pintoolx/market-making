import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openAIModel } from '../src/design-agent.ts'

test('provider failure metadata is redacted before SDK error logging', async () => {
  const original = globalThis.fetch, marker = 'private-fixture-never-log'
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: marker, type: 'invalid_request_error' } }), {
    status: 401, headers: { 'content-type': 'application/json', 'x-private-fixture': marker },
  })
  try {
    const model = openAIModel({ apiKey: marker })
    await assert.rejects(async () => await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Public test' }] }] }), (error: unknown) => {
      assert.equal(error instanceof Error && error.message, 'model-unavailable')
      assert.equal((error as { statusCode: number }).statusCode, 401)
      assert.equal(JSON.stringify(error).includes(marker), false)
      assert.equal(String(error).includes(marker), false)
      assert.equal('cause' in (error as object), false)
      return true
    })
  } finally { globalThis.fetch = original }
})
