import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keccak256, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { publicationMessage } from '../../../shared/lp-release.mjs'
import { compileLpRelease } from '../src/lp-release.ts'
import { loadDeployment } from '../src/config.ts'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`) // Public test identity, no chain writes.
const provider = account.address.toLowerCase()
const release = { schema: 'pintool-lp-release-v1', id: `${provider.slice(2)}-clmm`, version: 1, provider, name: 'Test', summary: 'Test range', state: 'published',
  execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700,
    maxAmount0PerSwap: '400000000000000', maxAmount1PerSwap: '1000000', maxPostBalance0: '1000000000000000000', maxPostBalance1: '1000000000', ttlSec: 300 } }
const envelope = { version: 1, ephemeralPublicKey: '22'.repeat(32), nonce: '33'.repeat(24), ciphertext: '44'.repeat(32) }
const sign = async (r = release) => { const message = publicationMessage(r, envelope); return { release: r, envelope, signature: await account.signMessage({ message }), digest: keccak256(stringToHex(message)) } }
const deployment = loadDeployment(11155111)
const input = async () => ({ publication: await sign(), maker: account.address, amounts: ['2000000000000000', '5000000'] as [string, string], salt: '1', deadline: 2000,
  reference: { price: '2500', observedAt: 1000 }, policy: { tokens: [deployment.tokens.WETH!, deployment.tokens.USDC!], baselineAmounts: ['2000000000000000', '5000000'], maxDrawdownBps: 500, maxPriceAgeSec: 90 } })

test('signed CLMM ranges retain asymmetric semantics, compile into the journal format and bind version changes to new hashes', async () => {
  const source = await input(), plan = await compileLpRelease(source, deployment, 1001)
  assert.deepEqual(plan.range, { min: '2425.000000000000000000', max: '2675.000000000000000000' })
  assert.equal(plan.request.action, 'ship'); assert.equal(plan.request.strategy.program.feeBps, 0)
  assert.deepEqual(await compileLpRelease(source, deployment, 1001), plan)
  const second = await compileLpRelease({ ...source, publication: await sign({ ...release, version: 2 }) }, deployment, 1001)
  assert.notEqual(second.strategyHash, plan.strategyHash)
  const wider = await compileLpRelease({ ...source, publication: await sign({ ...release, execution: { ...release.execution, rangeAboveBps: 900 } }) }, deployment, 1001)
  assert.notDeepEqual(wider.request.strategy.program, plan.request.strategy.program)
  assert.equal(wider.range.max, '2725.000000000000000000')
  assert.equal(plan.workflowBinding.strategyId, `${release.id}.v1`)
  assert.equal(plan.reportRequired, true)
})

test('tampering, stale reference, withdrawn release, wrong token domain and excess allocation cannot produce a plan', async () => {
  const source = await input()
  await assert.rejects(compileLpRelease({ ...source, publication: { ...source.publication, release: { ...release, name: 'Forged' } } }, deployment, 1001), /Invalid signed/)
  await assert.rejects(compileLpRelease(source, deployment, 1091), /stale/)
  await assert.rejects(compileLpRelease({ ...source, publication: await sign({ ...release, state: 'withdrawn' }) }, deployment, 1001), /requires/)
  await assert.rejects(compileLpRelease({ ...source, amounts: ['2000000000000000', '1000000001'] }, deployment, 1001), /Allocation/)
  await assert.rejects(compileLpRelease(source, { ...deployment, tokens: { ...deployment.tokens, WETH: account.address } }, 1001), /token domain/)
})
