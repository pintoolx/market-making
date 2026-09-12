import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zeroAddress, zeroHash } from 'viem'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { readBuilderInventory } from '../src/builder-inventory.ts'

const maker = '0x1111111111111111111111111111111111111111'
test('inventory rejects wrong manifests and aborted requests before RPC, without disclosing operator URLs', async () => {
  const original = globalThis.fetch, requests: string[] = []
  globalThis.fetch = async input => { requests.push(String(input)); throw new Error('must-not-call') }
  try {
    await assert.rejects(readBuilderInventory({ ...profile, forwarder: maker }, maker, [], { rpcUrl: 'https://fixture.invalid' }), /inventory-manifest-unverified/)
    await assert.rejects(readBuilderInventory(profile, maker, [], { rpcUrl: 'https://fixture.invalid', signal: AbortSignal.abort() }), /inventory-read-unavailable/)
    await assert.rejects(readBuilderInventory(profile, maker, [], { rpcUrl: 'operator-secret-not-a-url' }), error => {
      assert.equal(String(error).includes('operator-secret'), false); return true
    })
    assert.equal(requests.length, 0)
  } finally { globalThis.fetch = original }
})

test('inventory refuses wrong-chain, stale-block and substituted contract code contexts through read-only RPC methods', async () => {
  const original = globalThis.fetch
  try {
    for (const variant of ['chain','stale','code'] as const) {
      const methods: string[] = []
      globalThis.fetch = async (_input, init) => {
        const req = JSON.parse(String(init!.body)), now = Math.floor(Date.now() / 1000)
        methods.push(req.method)
        assert.ok(['eth_chainId','eth_getBlockByNumber','eth_getCode'].includes(req.method))
        const block = { hash: zeroHash, number: '0x1', timestamp: '0x' + (variant === 'stale' ? now - 180 : now).toString(16), transactions: [],
          parentHash: zeroHash, miner: zeroAddress, gasLimit: '0x0', gasUsed: '0x0', difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', uncles: [] }
        const result = req.method === 'eth_chainId' ? '0x' + (variant === 'chain' ? 1 : profile.chainId).toString(16)
          : req.method === 'eth_getBlockByNumber' ? block : '0x00'
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'content-type': 'application/json' } })
      }
      await assert.rejects(readBuilderInventory(profile, maker, [], { rpcUrl: 'https://fixture.invalid' }),
        variant === 'code' ? /inventory-code-mismatch/ : /inventory-block-unavailable/)
      assert.ok(methods.includes('eth_chainId')); assert.ok(methods.includes('eth_getBlockByNumber'))
      assert.equal(methods.includes('eth_getCode'), variant === 'code')
    }
  } finally { globalThis.fetch = original }
})

test('optional actual Sepolia inventory read verifies one block without transactions or a wallet signer', { skip: !process.env.BUILDER_INVENTORY_TEST_RPC_URL }, async () => {
  const result = await readBuilderInventory(profile, maker, [], { rpcUrl: process.env.BUILDER_INVENTORY_TEST_RPC_URL! })
  assert.equal(result.mode, 'live-read'); assert.equal(result.chainId, profile.chainId)
  assert.equal(result.contracts.length, 6); assert.equal(result.tokens.length, 2)
  assert.equal(result.commitmentsComplete, false); assert.equal(result.registrationReady, false)
  assert.ok(result.limitations.some(text => text.includes('cannot be summed')))
})
