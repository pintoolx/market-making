import type { Address } from 'viem';
import { normalize } from 'viem/ens';
import { createEnsReader } from '../../../../shared/ens/chain.mjs';
import { publicReleaseHash, strategyName, type EnsSelection, type ReleasePointer } from '../../../../shared/ens/schema.mjs';
import type { Listing } from '../marketplace/publishedStore';
import { request } from '../marketplace/mandateClient';
import { ensClient, getEnsConfig, resolveEnsStrategy, selectionFrom, verifyManifest, type EnsResolution, type PublicManifest } from './ensClient';

export type StrategyNames = { providerName?: string; ensName?: string; ensSelection?: EnsSelection; ensStatus?: 'current' | 'historical'; ensError?: string };
type IndexedName = { name: string; pointer?: ReleasePointer; verified: boolean };
export type NameSource = {
  provider: (address: string) => Promise<string | undefined>;
  names: () => Promise<IndexedName[]>;
  resolve: (name: string) => Promise<EnsResolution>;
  approved: (name: string, id: string, version: number) => Promise<PublicManifest>;
};

// The index is discovery only. A name must bind to this exact signed publication.
function matches(listing: Listing, manifest: PublicManifest) {
  const p = manifest.pointer;
  return !!listing.publication && p.releaseId === listing.releaseId && p.version === listing.version
    && p.provider.toLowerCase() === listing.provider?.toLowerCase()
    && p.publicationDigest === listing.publication.digest
    && publicReleaseHash(manifest.release) === publicReleaseHash(listing.publication);
}

export function createStrategyNameDiscovery(source: NameSource) {
  return async (listing: Listing, preferred?: string): Promise<StrategyNames> => {
    if (!listing.publication || !listing.releaseId || !listing.version || !/^0x[0-9a-f]{40}$/i.test(listing.provider ?? '')) return {};
    const provider = listing.provider!;
    const [providerName, index] = await Promise.all([
      source.provider(provider).catch(() => undefined),
      preferred ? Promise.resolve([]) : source.names().catch(() => []),
    ]);
    const candidates = preferred ? [preferred] : (Array.isArray(index) ? index : []).filter(item => item?.pointer?.releaseId === listing.releaseId
      && typeof item?.pointer?.provider === 'string' && item.pointer.provider.toLowerCase() === provider.toLowerCase()).map(item => item.name).sort();
    const normalized = candidates.flatMap(name => { try { return [normalize(name)]; } catch { return []; } });
    for (const name of [...new Set(normalized)]) {
      try {
        const resolved = await source.resolve(name);
        if (resolved.name !== name || resolved.manifest.name !== name) continue;
        const current = resolved.manifest;
        if (matches(listing, current)) return { providerName: providerName ?? name.split('.').slice(1).join('.'),
          ensName: name, ensStatus: 'current', ensSelection: selectionFrom(resolved) };
        // Old share links keep their version, with a separate historical name label.
        if (current.pointer.releaseId !== listing.releaseId || current.pointer.provider.toLowerCase() !== provider.toLowerCase()) continue;
        const historical = await source.approved(name, listing.releaseId, listing.version);
        if (historical.name === name && matches(listing, historical)) return { providerName: providerName ?? name.split('.').slice(1).join('.'), ensName: name, ensStatus: 'historical' };
      } catch { /* A failed or stale name never replaces the selected publication. */ }
    }
    return { providerName, ...(preferred ? { ensError: 'This ENS name could not be verified for the selected version.' } : {}) };
  };
}

const cache = new Map<string, { until: number; value: Promise<unknown> }>();
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const saved = cache.get(key);
  if (saved && saved.until > Date.now()) return saved.value as Promise<T>;
  const value = read().catch(error => { if (cache.get(key)?.value === value) cache.delete(key); throw error; });
  cache.set(key, { until: Date.now() + 15_000, value });
  return value;
}
export const clearStrategyNameCache = () => cache.clear();

export const discoverStrategyNames = createStrategyNameDiscovery({
  provider: address => cached(`provider:${address.toLowerCase()}`, async () => {
    const { rootName } = await getEnsConfig();
    const result = await createEnsReader({ rootName, client: ensClient }).provider(address as Address);
    return result.provider?.name;
  }),
  names: () => cached('index', async () => (await request<{ names: IndexedName[] }>('/v1/ens/names')).names),
  resolve: resolveEnsStrategy,
  approved: async (name, id, version) => {
    const { rootName } = await getEnsConfig();
    strategyName(name, rootName);
    const manifest = await request<PublicManifest>(`/v1/ens/manifest?${new URLSearchParams({ name, releaseId: id, version: String(version) })}`);
    return verifyManifest(manifest, rootName);
  },
});
