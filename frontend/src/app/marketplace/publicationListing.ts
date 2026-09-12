import type { PublicRelease } from './ClmmPublisher';
import type { Listing } from './publishedStore';
import { AQUA_TEMPLATES } from './aquaTemplates';

export function listingFromRelease(release: PublicRelease): Listing {
  return { id: `${release.id}.v${release.version}`, releaseId: release.id, version: release.version,
    name: release.name, summary: release.summary, provider: release.provider,
    template: AQUA_TEMPLATES.find(t => t.id === 'clmm')!, mine: false, feePct: 0, publication: release };
}
