import type { MandateStrategy } from './mandateClient';

export const ADAPTIVE_PROFILE_IDS = ['featured-tight-market', 'featured-defensive-market'] as const;
type Profile = Pick<MandateStrategy, 'listingId' | 'name' | 'status'> & Partial<MandateStrategy>;

export function presentMandate(strategies: MandateStrategy[]) {
  const adaptive = strategies.length > 0 && strategies.every(item =>
    ADAPTIVE_PROFILE_IDS.some(id => id === item.listingId));
  const profiles: Profile[] = adaptive ? ADAPTIVE_PROFILE_IDS.map((id, index) => ({
    listingId: id,
    status: 'standby' as const,
    ...strategies.find(item => item.listingId === id),
    name: index === 0 ? 'Tight profile' : 'Defensive profile',
  })) : strategies;
  return {
    adaptive,
    name: adaptive ? 'Adaptive Market Maker' : strategies.length === 1 ? strategies[0].name : 'Your strategies',
    profiles,
    profileName: (id: string) => profiles.find(item => item.listingId === id)?.name ?? 'Unknown strategy',
  };
}
