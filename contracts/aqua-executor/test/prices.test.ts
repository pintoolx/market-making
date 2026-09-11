import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chainlinkSnapshot, type OracleSample } from '../src/prices.ts'

const tokens: `0x${string}`[] = ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
const now = 1_800_000_000
const sample = (): OracleSample => ({
  chainId: 8453, blockNumber: 123n, blockTimestamp: BigInt(now),
  sequencer: [1n, 0n, BigInt(now - 3601), BigInt(now - 10), 1n],
  feeds: [
    { description: 'ETH / USD', decimals: 8, round: [2n, 250012345678n, BigInt(now - 10), BigInt(now - 10), 2n] },
    { description: 'USDC / USD', decimals: 8, round: [3n, 99984987n, BigInt(now - 20_000), BigInt(now - 20_000), 3n] },
  ],
})

test('Chainlink preserves actual observation times and the USDC price instead of assuming a dollar peg', () => {
  const p = chainlinkSnapshot(tokens, sample(), now)
  assert.equal(p.asOf, now - 20_000)
  assert.equal(p.mode, 'live')
  assert.deepEqual(p.usdE8, { [tokens[0]!]: '250012345678', [tokens[1]!]: '99984987' })
  assert.equal(p.evidence?.fetchedAt, now)
  const data = sample()
  data.feeds[0]!.decimals = 18
  data.feeds[0]!.round = [2n, 2500123456789999999999n, BigInt(now), BigInt(now), 2n]
  assert.equal(chainlinkSnapshot(tokens, data, now).usdE8[tokens[0]!], '250012345678')
})

test('Chainlink validates each feed heartbeat independently', () => {
  for (const [index, maxAge] of [[0, 1320], [1, 86520]] as const) {
    const data = sample()
    data.feeds[index]!.round = [1n, 100000000n, BigInt(now - maxAge), BigInt(now - maxAge), 1n]
    assert.doesNotThrow(() => chainlinkSnapshot(tokens, data, now))
    data.feeds[index]!.round = [1n, 100000000n, BigInt(now - maxAge - 1), BigInt(now - maxAge - 1), 1n]
    assert.throws(() => chainlinkSnapshot(tokens, data, now), /stale .* round/)
  }
})

test('Chainlink rejects bad rounds, wrong feeds and an unhealthy oracle chain', () => {
  const cases: ((d: OracleSample) => void)[] = [
    d => { d.chainId = 84532 },
    d => { d.blockTimestamp = BigInt(now - 61) },
    d => { d.blockTimestamp = BigInt(now + 6) },
    d => { d.sequencer = [1n, 1n, BigInt(now - 4000), BigInt(now), 1n] },
    d => { d.sequencer = [1n, 0n, BigInt(now - 3600), BigInt(now), 1n] },
    d => { d.sequencer = [1n, 0n, 0n, BigInt(now), 1n] },
    d => { d.feeds[0]!.round = [1n, 0n, BigInt(now), BigInt(now), 1n] },
    d => { d.feeds[0]!.round = [1n, -1n, BigInt(now), BigInt(now), 1n] },
    d => { d.feeds[0]!.round = [1n, 1n, BigInt(now), BigInt(now + 1), 1n] },
    d => { d.feeds[0]!.round = [0n, 1n, BigInt(now), BigInt(now), 1n] },
    d => { d.feeds[0]!.description = 'BTC / USD' },
    d => { d.feeds[0]!.decimals = 19 },
    d => { d.feeds.pop() },
  ]
  for (const change of cases) {
    const data = sample()
    change(data)
    assert.throws(() => chainlinkSnapshot(tokens, data, now))
  }
})
