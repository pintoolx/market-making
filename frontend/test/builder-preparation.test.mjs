import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftSchema, digestJson, sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import { compileBuilderStrategy } from '../../contracts/aqua-executor/src/builder-compile.ts';
import { verifyCompilation, verifyInventory, evidenceLabel, isReportEvidenceHash, isReportNonce, verifyTransactionPlan } from '../src/app/builder/preparation.ts';
import { fixtureInventory } from '../../packages/builder-service/test/browser/preparation-fixture.mjs';
import { contentDigest } from '@pintool/strategy-builder';

const maker = '0x2222222222222222222222222222222222222222';
function draft() {
  const now = new Date().toISOString();
  return draftSchema.parse({ schemaVersion: 1, id: 'preparation-review', owner: 'wallet:' + maker, kind: 'maker', maker, revision: 2, salt: '42', createdAt: now, updatedAt: now,
    allocations: { baseAtomic: '10000000000000000', quoteAtomic: '25000000' }, requirements: [],
    spec: { title: 'Maker preparation', profileId: profile.id, baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 3600, guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' } } });
}
test('read-only compilation review rejects substituted revision, caps, identities, allocations and program hashes', () => {
  const d = draft(), payload = compileBuilderStrategy(d, profile, Math.floor(Date.now() / 1000));
  const value = { artifactId: 'fixture-artifact', mode: 'compiled-order', current: true, registrationReady: false, createdAt: d.createdAt, payload };
  assert.deepEqual(verifyCompilation(value, d), value);
  assert.throws(() => verifyCompilation(value, d, 'another-artifact'));
  for (const mutate of [v => v.payload.revision++, v => { v.current = false; }, v => { v.payload.amounts[0] = '1'; },
    v => { v.payload.decoded.guardEnvelope.maxAmountBasePerSwap = '1'; }, v => { v.payload.programHash = '0x' + '12'.repeat(32); },
    v => { v.payload.tokens.reverse(); }, v => { v.payload.manifestHash = '0x' + '12'.repeat(32); }, v => { v.registrationReady = true; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => verifyCompilation(changed, d));
  }
  assert.throws(() => verifyCompilation(value, { ...d, maker: '0x3333333333333333333333333333333333333333' }));
});
test('inventory display is bound to the Maker, revision, verified pair and allocations, and preserves the evidence mode', async () => {
  const d = draft(), inventory = await fixtureInventory(maker, []);
  const value = { draftId: d.id, revision: 2, contentDigest: contentDigest(d), knownArtifactsTruncated: false, requestedAllocations: d.allocations, registrationReady: false, inventory };
  assert.deepEqual(verifyInventory(value, d), value);
  for (const mutate of [v => { v.inventory.maker = '0x3333333333333333333333333333333333333333'; }, v => v.revision++,
    v => { v.inventory.tokens[0].decimals = 6; }, v => { v.inventory.tokens[0].walletBalanceAtomic = '-1'; },
    v => { v.inventory.spender = maker; }, v => { v.requestedAllocations.baseAtomic = '1'; }, v => { v.inventory.mode = 'TEE'; },
    v => { v.inventory.commitmentsComplete = true; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => verifyInventory(changed, d));
  }
  assert.match(evidenceLabel('mock'), /No onchain/); assert.match(evidenceLabel('fork-with-overrides'), /Synthetic/);
  assert.match(evidenceLabel('live-read'), /Sepolia read/);
});

test('wallet plans are displayed only when their immutable artifact bindings and calldata shape match', () => {
  const d = draft(), payload = compileBuilderStrategy(d, profile, Math.floor(Date.now() / 1000));
  const artifact = { artifactId: 'fixture-artifact', mode: 'compiled-order', current: true, registrationReady: false, createdAt: d.createdAt, payload };
  const tx = (kind, to) => ({ kind, to, data: '0x1234', value: '0x0', description: kind });
  const plan = { schemaVersion: 1, kind: 'registration', id: 'plan', chainId: profile.chainId, owner: d.owner, maker: d.maker, draftId: d.id, revision: d.revision,
    artifactId: artifact.artifactId, contentDigest: contentDigest(d), manifestHash: digestJson(profile), strategyHash: payload.strategyHash, programHash: payload.programHash, orderHash: payload.orderHash,
    tokens: payload.tokens, amounts: payload.amounts, transactions: [tx('erc20-approve', payload.tokens[0]), tx('erc20-approve', payload.tokens[1]), tx('aqua-ship', profile.aqua)], preconditions: ['fresh read'], registrationReady: false };
  const result = { plan, digest: digestJson(plan) };
  assert.deepEqual(verifyTransactionPlan(result, d, artifact, 'registration'), result);
  assert.throws(() => verifyTransactionPlan({ ...result, digest: '0x' + '11'.repeat(32) }, d, artifact, 'registration'));
  assert.throws(() => verifyTransactionPlan({ plan: { ...plan, transactions: plan.transactions.slice(0, 1) }, digest: digestJson({ ...plan, transactions: plan.transactions.slice(0, 1) }) }, d, artifact, 'registration'));
  assert.equal(isReportEvidenceHash('0x' + 'ab'.repeat(32)), true);
  assert.equal(isReportEvidenceHash('0x' + 'ab'.repeat(31)), false);
  assert.equal(isReportNonce('1'), true);
  assert.equal(isReportNonce('0'), false);
});
