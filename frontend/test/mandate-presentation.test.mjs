import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentMandate } from '../src/app/marketplace/mandatePresentation.ts';

test('a published strategy retains its identity and never gains featured profiles', () => {
  const strategy = { listingId: 'provider-clmm.v1', name: 'Range Maker', provider: '0x123', status: 'active', strategyHash: '0xabc' };
  const view = presentMandate([strategy]);
  assert.equal(view.name, 'Range Maker');
  assert.equal(view.adaptive, false);
  assert.deepEqual(view.profiles, [strategy]);
  assert.equal(view.profileName(strategy.listingId), strategy.name);
});

test('the featured product keeps its candidate profiles and resolves the active profile by ID', () => {
  const view = presentMandate([{ listingId: 'featured-defensive-market', name: 'Defensive Market', status: 'active' }]);
  assert.equal(view.name, 'Adaptive Market Maker');
  assert.equal(view.profiles.length, 2);
  assert.equal(view.profiles[0].status, 'standby');
  assert.equal(view.profileName('featured-defensive-market'), 'Defensive profile');
});

test('mixed and empty mandates do not imply a featured product', () => {
  const items = [{ listingId: 'featured-tight-market', name: 'Tight Market', status: 'standby' },
    { listingId: 'provider-clmm.v2', name: 'Updated Range', status: 'active' }];
  assert.deepEqual(presentMandate(items).profiles, items);
  assert.equal(presentMandate(items).name, 'Your strategies');
  assert.deepEqual(presentMandate([]).profiles, []);
});
