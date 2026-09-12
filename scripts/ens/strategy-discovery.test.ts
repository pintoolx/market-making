import { describe, expect, test } from 'bun:test';
import { namehash } from 'viem/ens';
import { createStrategyNameDiscovery, type NameSource } from '../../frontend/src/app/ens/strategyNames';
import type { EnsResolution, PublicManifest } from '../../frontend/src/app/ens/ensClient';
import { listingFromRelease } from '../../frontend/src/app/marketplace/publicationListing';
import { strategyHref, rememberMarketplace, consumeMarketplaceReturn, marketplaceReturn, restoreMarketplaceScroll } from '../../frontend/src/app/marketplace/strategyLinks';
import { loadStrategyListing } from '../../frontend/src/app/marketplace/strategyCatalog';
import type { PublicRelease } from '../../frontend/src/app/marketplace/ClmmPublisher';
import { releasePointer } from '../../shared/ens/schema.mjs';

const provider = '0x1111111111111111111111111111111111111111';
const name = 'range.alice.pintool.eth';
function publication(version = 1): PublicRelease {
  return { schema: 'pintool-lp-release-v1', id: `${provider.slice(2)}-clmm`, version, provider, name: `Range v${version}`,
    summary: 'Public test strategy', state: 'published', digest: `0x${String(version).repeat(64)}`, executionStatus: 'requires-provisioning',
    execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700,
      maxAmount0PerSwap: '4000', maxAmount1PerSwap: '1000', maxPostBalance0: '100000', maxPostBalance1: '100000', ttlSec: 300 } };
}
function manifest(version = 1): PublicManifest {
  const { digest, executionStatus: _, ...release } = publication(version);
  return { name, release, pointer: releasePointer(release, digest), signature: '0x00' };
}
function resolution(version = 1): EnsResolution {
  return { name, node: namehash(name), provider, registry: provider, resolver: provider,
    pointer: manifest(version).pointer, manifest: manifest(version), blockNumber: '123', blockHash: `0x${'a'.repeat(64)}`, checkedAt: '2026-09-13T00:00:00Z' };
}
function source(overrides: Partial<NameSource> = {}): NameSource {
  return { provider: async () => 'alice.pintool.eth', names: async () => [{ name, verified: true, pointer: manifest().pointer }],
    resolve: async () => resolution(), approved: async (_, __, version) => manifest(version), ...overrides };
}

describe('strategy names bind to the viewed publication', () => {
  test('listing discovery and explicit ENS entry produce identical identities and selection', async () => {
    const discover = createStrategyNameDiscovery(source());
    const listing = listingFromRelease(publication());
    const card = await discover(listing);
    expect(await discover(listing, name)).toEqual(card);
    expect(card).toMatchObject({ providerName: 'alice.pintool.eth', ensName: name, ensStatus: 'current' });
    expect(card.ensSelection?.pointer).toEqual(manifest().pointer);
    expect(await discover(listing, name.toUpperCase())).toEqual(card);
  });
  test('a verified index flag alone cannot authorize a name', async () => {
    const discover = createStrategyNameDiscovery(source({ resolve: async () => { throw new Error('Ownership changed'); } }));
    const result = await discover(listingFromRelease(publication()), name);
    expect(result.ensName).toBeUndefined();
    expect(result.ensSelection).toBeUndefined();
    expect(result.ensError).toBeDefined();
  });
  test('a different digest cannot attach to the same release ID and version', async () => {
    const listing = listingFromRelease({ ...publication(), digest: `0x${'f'.repeat(64)}` });
    const result = await createStrategyNameDiscovery(source())(listing, name);
    expect(result.ensName).toBeUndefined();
    expect(result.ensSelection).toBeUndefined();
  });
  test('tampered displayed public fields cannot borrow a valid signed manifest', async () => {
    const listing = listingFromRelease({ ...publication(), name: 'Substituted public strategy' });
    const result = await createStrategyNameDiscovery(source())(listing, name);
    expect(result.ensName).toBeUndefined();
    expect(result.ensSelection).toBeUndefined();
  });
  test('ENS advancing to v2 retains a signed historical v1 label without a current ENS selection', async () => {
    const listing = listingFromRelease(publication());
    const discover = createStrategyNameDiscovery(source({ resolve: async () => resolution(2), names: async () => [{ name, verified: true, pointer: manifest(2).pointer }] }));
    for (const preferred of [undefined, name]) {
      const result = await discover(listing, preferred);
      expect(result).toMatchObject({ ensName: name, ensStatus: 'historical', providerName: 'alice.pintool.eth' });
      expect(result.ensSelection).toBeUndefined();
      expect(listing.version).toBe(1);
    }
  });
  test('an unrelated Provider cannot lend their name to this publication', async () => {
    const other = resolution();
    other.manifest.pointer = { ...other.manifest.pointer, provider: '0x2222222222222222222222222222222222222222' };
    const result = await createStrategyNameDiscovery(source({ resolve: async () => other }))(listingFromRelease(publication()), name);
    expect(result.ensName).toBeUndefined();
  });
  test('an unavailable historical signature cannot produce a historical or current label', async () => {
    const discover = createStrategyNameDiscovery(source({ resolve: async () => resolution(2), approved: async () => { throw new Error('Manifest withdrawn'); } }));
    const result = await discover(listingFromRelease(publication()), name);
    expect(result.ensName).toBeUndefined();
    expect(result.ensError).toBeDefined();
  });
  test('ENS outages leave the publication and address usable', async () => {
    const discover = createStrategyNameDiscovery(source({ provider: async () => { throw new Error('RPC unavailable'); }, names: async () => { throw new Error('Index unavailable'); } }));
    const listing = listingFromRelease(publication());
    expect(await discover(listing)).toEqual({ providerName: undefined });
    expect(listing.provider).toBe(provider);
    expect(listing.version).toBe(1);
  });
});

test('an exact-version URL never falls back to a different or withdrawn release', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let reply = publication(2);
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return Response.json(reply);
  }) as typeof fetch;
  try {
    const id = listingFromRelease(publication()).id;
    await expect(loadStrategyListing(id)).rejects.toThrow('Publication version mismatch');
    reply = { ...publication(), state: 'withdrawn' };
    await expect(loadStrategyListing(id)).rejects.toThrow('withdrawn');
    reply = publication();
    expect((await loadStrategyListing(id)).version).toBe(1);
    expect(requests.length).toBe(3);
    expect(requests.every(url => url.endsWith(`/v1/provider-strategies/${reply.id}/versions/1`))).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});

test('share URLs retain exact publication/version and optional name across parsing', () => {
  const first = listingFromRelease(publication());
  const second = listingFromRelease(publication(2));
  const url = new URL(strategyHref(first.id, name), 'https://mm.pintool.fun');
  expect(url.pathname).toBe('/strategy');
  expect(url.searchParams.get('id')).toBe(first.id);
  expect(url.searchParams.get('ens')).toBe(name);
  expect(strategyHref(first.id)).not.toBe(strategyHref(second.id));
});

test('returning restores the search/scroll once without changing future Maker landing behavior', () => {
  const originals = ['window', 'document', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const storage = new Map<string, string>();
  let restored = 0;
  const values = {
    window: { location: { pathname: '/maker', search: `?ens=${name}` } },
    document: { querySelector: () => ({ scrollTop: 420, scrollTo: ({ top }: { top: number }) => { restored = top; } }) },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  };
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    rememberMarketplace();
    expect(marketplaceReturn().url).toBe(`/maker?ens=${name}`);
    expect(consumeMarketplaceReturn()).toBe(true);
    expect(consumeMarketplaceReturn()).toBe(false);
    restoreMarketplaceScroll();
    expect(restored).toBe(420);
    storage.set('pintool:strategy-return', JSON.stringify({ url: '//example.invalid', scroll: 1 }));
    expect(marketplaceReturn().url).toBe('/maker');
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
