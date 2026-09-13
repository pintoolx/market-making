import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { eventMatchesInstance } from '../src/event-routing.ts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import type { PublicEvent } from '../src/event-delivery.ts'
const maker = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222', hash = `0x${'1'.repeat(64)}` as `0x${string}`
const base = { source: 'chain.test', eventId: 'one', kind: 'evm.log', observedAt: new Date().toISOString(), chainId: profile.chainId,
  transactionHash: hash, blockHash: hash, blockNumber: '42', logIndex: 0 }

test('non-indexed Aqua events require exact Maker, app and strategy; a matching source alone is insufficient', () => {
  const abi = parseAbi(['event Docked(address maker,address app,bytes32 strategyHash)'])
  const event = (wallet = maker, app = profile.router, strategyHash = hash): PublicEvent => ({ ...base, payload: { address: profile.aqua,
    topics: encodeEventTopics({ abi, eventName: 'Docked' }), data: encodeAbiParameters([{type:'address'},{type:'address'},{type:'bytes32'}], [wallet as `0x${string}`, app, strategyHash]) } })
  assert.equal(eventMatchesInstance(event(), profile, maker, hash), true)
  for (const value of [event(other), event(maker, other), event(maker, profile.router, `0x${'2'.repeat(64)}`), { ...event(), chainId: 1 }, { ...event(), payload: { ...event().payload, data: '0x1234' } }])
    assert.equal(eventMatchesInstance(value, profile, maker, hash), false)
})

test('token events match only Maker transfers or Maker approvals to Aqua', () => {
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event Approval(address indexed owner,address indexed spender,uint256 value)'])
  const event = (owner: string, spender: string): PublicEvent => ({ ...base, payload: { address: profile.tokens[0]!.address,
    topics: encodeEventTopics({ abi, eventName: 'Approval', args: { owner: owner as `0x${string}`, spender: spender as `0x${string}` } }),
    data: encodeAbiParameters([{type:'uint256'}], [1n]) } })
  assert.equal(eventMatchesInstance(event(maker, profile.aqua), profile, maker, hash), true)
  assert.equal(eventMatchesInstance(event(other, profile.aqua), profile, maker, hash), false)
  assert.equal(eventMatchesInstance(event(maker, profile.router), profile, maker, hash), false)
  assert.equal(eventMatchesInstance({ ...event(maker, profile.aqua), payload: { ...event(maker, profile.aqua).payload, address: other } }, profile, maker, hash), false)
})
