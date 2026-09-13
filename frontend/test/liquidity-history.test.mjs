import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listMandates } from '../src/app/marketplace/mandateClient.ts';

const maker = `0x${'11'.repeat(20)}`;
const summary = { mandateId: 'mandate-11111111-1111-1111-1111-111111111111', maker,
  strategies: [{ listingId: 'range.v1', name: 'Range Maker' }], chainId: 11155111,
  networkName: 'Ethereum Sepolia', reportSequence: '123', lastActivityAt: null };

test('history requests one wallet and keeps separate setups for the same strategy', async t => {
  const second = { ...summary, mandateId: 'mandate-22222222-2222-2222-2222-222222222222' };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).searchParams.get('maker'), maker);
    return new Response(JSON.stringify({ mandates: [summary, second] }));
  });
  assert.deepEqual(await listMandates(maker), [summary, second]);
});

test('history rejects foreign wallet records and incomplete responses', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ mandates: [{ ...summary, maker: `0x${'22'.repeat(20)}` }] })));
  await assert.rejects(listMandates(maker), /could not be verified/);
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ mandates: [{ ...summary, strategies: [] }] })));
  await assert.rejects(listMandates(maker), /could not be verified/);
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }));
  await assert.rejects(listMandates(maker), /Service unavailable/);
  await assert.rejects(listMandates('bad'), /Maker address is invalid/);
});
