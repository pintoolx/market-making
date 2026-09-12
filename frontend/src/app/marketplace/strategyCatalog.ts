import type { PublicRelease } from './ClmmPublisher';
import { listingFromRelease } from './publicationListing';
import { FEATURED } from './featuredStrategies';
import { readPublished, type Listing } from './publishedStore';
import { request } from './mandateClient';


export async function loadStrategyListing(id: string): Promise<Listing> {
  const version = id.match(/^([0-9a-f]{40}-clmm)\.v([1-9][0-9]{0,6})$/);
  if (version) {
    const release = await request<PublicRelease>(`/v1/provider-strategies/${version[1]}/versions/${version[2]}`);
    if (release.id !== version[1] || release.version !== Number(version[2]) || release.provider !== `0x${version[1].slice(0, 40)}`) throw new Error('Publication version mismatch.');
    if (release.state !== 'published') throw new Error('This strategy version has been withdrawn.');
    return listingFromRelease(release);
  }
  const existing = [...FEATURED, ...readPublished()].find(item => item.id === id);
  if (!existing) throw new Error('This strategy could not be found. Return to the marketplace to choose a strategy.');
  return existing;
}
