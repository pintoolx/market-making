import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createProviderRegistry } from '../src/provider-registry.mjs';
import { makeServer } from '../src/server.mjs';
import { parseRelease, percentToBps, providerPolicy, publicationMessage } from '../../shared/lp-release.mjs';

// Public deterministic TEST identity; never used by an execution wallet.
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const release = (version = 1) => ({ schema: 'pintool-lp-release-v1', id: `${signer.address.toLowerCase().slice(2)}-clmm`, version,
  provider: signer.address.toLowerCase(), name: 'Asymmetric range', summary: 'Public CLMM envelope', state: 'published',
  execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700,
    maxAmount0PerSwap: '400000000000000', maxAmount1PerSwap: '1000000', maxPostBalance0: '1000000000000000000', maxPostBalance1: '1000000000', ttlSec: 300 } });
const envelope = { version: 1, ephemeralPublicKey: '22'.repeat(32), nonce: '33'.repeat(24), ciphertext: '44'.repeat(32) };
const signed = async r => ({ release: r, envelope, signature: await signer.signMessage({ message: publicationMessage(r, envelope) }) });

test('signed publication survives restart; updates, retries and withdrawal preserve immutable history without exposing ciphertext', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-registry-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = createProviderRegistry(dir), first = await signed(release());
  const saved = await registry.publish(first);
  assert.equal(saved.version, 1); assert.equal(saved.executionStatus, 'requires-provisioning');
  const restarted = createProviderRegistry(dir);
  assert.deepEqual(await restarted.publish(first), saved);
  assert.deepEqual((await restarted.read(saved.id, 1)).envelope, envelope);
  const second = await signed({ ...release(2), name: 'Updated range' });
  await restarted.publish(second);
  assert.deepEqual(await restarted.publish(first), saved);
  assert.equal((await restarted.read(saved.id, 1)).release.name, 'Asymmetric range');
  await restarted.publish(await signed({ ...release(3), state: 'withdrawn' }));
  const listing = await restarted.list();
  assert.equal(listing[0].state, 'withdrawn');
  assert.equal(JSON.stringify(listing).includes(envelope.ciphertext), false);
  assert.equal(JSON.stringify(listing).includes('volatilityBpsMax'), false);
  await restarted.publish(await signed(release(4)));
  assert.equal((await restarted.latest(saved.id)).withdrawnThrough, 3);
  assert.equal((await restarted.latest(saved.id)).release.state, 'published');
});

test('tampering, stale updates, missing versions and concurrent conflicting writers cannot overwrite a version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-conflict-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = createProviderRegistry(dir), input = await signed(release());
  await assert.rejects(registry.publish({ ...input, release: { ...input.release, name: 'tampered' } }), /signature/);
  await assert.rejects(registry.publish(await signed(release(2))), /Version conflict/);
  const other = await signed({ ...release(), name: 'Another writer' });
  const results = await Promise.allSettled([registry.publish(input), registry.publish(other)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await assert.rejects(registry.read('../escape', 1), /Invalid/);
});

test('shared schema rejects unsupported fees, hidden fields and inexact units; executable policy uses the same public ceilings', () => {
  assert.equal(percentToBps('3.25'), 325);
  assert.throws(() => percentToBps('3.255'));
  assert.throws(() => parseRelease({ ...release(), privateThreshold: 7 }));
  for (const bad of [{ feeBps: 30 }, { curve: 'xyc' }, { rangeBelowBps: 10000 }, { maxAmount1PerSwap: '1.1' }, { ttlSec: 601 }]) {
    assert.throws(() => parseRelease({ ...release(), execution: { ...release().execution, ...bad } }));
  }
  const policy = providerPolicy(release(), 325);
  assert.equal(policy.strategyId, `${release().id}.v1`);
  assert.equal(policy.rules[0].when.volatilityBpsMax, 325);
  assert.equal(policy.rules[0].maxAmount1PerSwap, '1000000');
  assert.equal(policy.rules[0].allowMakerBuyToken0, true);
  assert.equal(policy.rules[0].allowMakerSellToken0, true);
});

test('HTTP publication returns persisted versions without publishing private policy or activating a Maker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-http-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const server = makeServer({ stateDir: dir, allowedOrigin: 'http://localhost:3200', strategies: [], strategyMaker: signer.address }, {
    runner: async () => { throw new Error('Publication must never run CRE'); },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/v1/provider-strategies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const input = await signed(release());
  assert.equal((await post(input)).status, 200);
  assert.equal((await post({ ...input, release: { ...release(), name: 'tampered' } })).status, 400);
  assert.equal((await post(await signed({ ...release(2), name: 'Second version' }))).status, 200);
  const historical = await (await fetch(`${base}/v1/provider-strategies/${release().id}/versions/1`)).json();
  assert.equal(historical.name, 'Asymmetric range');
  const list = await (await fetch(base + '/v1/provider-strategies')).json();
  assert.equal(list.strategies[0].version, 2);
  assert.equal(JSON.stringify(list).includes('ciphertext'), false);
  assert.equal(JSON.stringify(historical).includes('ciphertext'), false);
  assert.deepEqual((await (await fetch(base + '/v1/strategies')).json()).strategies, []);
});
