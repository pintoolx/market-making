'use client';

import Avatar from '../components/shared/Avatar';
import { useAccount } from '../providers/useAccount';
import { useBasicProfile, useProviderProfile } from '../profile/profileStore';
import type { Listing } from './publishedStore';
import aqua from './aqua.module.css';

export default function ProviderIdentity({ listing }: { listing: Listing }) {
  const account = useAccount();
  const ownProfile = useBasicProfile(account.userId ?? 'guest', account.address).profile;
  const address = !!listing.provider && /^0x[0-9a-f]{40}$/i.test(listing.provider);
  const cachedProfile = useProviderProfile(address ? listing.provider : undefined);
  if (!listing.provider) return null;
  const isCurrentProvider = address && account.address?.toLowerCase() === listing.provider.toLowerCase();
  const profile = isCurrentProvider ? ownProfile : cachedProfile;
  const label = profile.displayName || listing.providerName || (address ? 'Strategy Provider' : listing.provider);
  return <div className={`${aqua.byline} ${aqua.providerIdentity}`}>
    <Avatar name={label} src={listing.providerAvatar ?? profile.avatar} size={28} brand={listing.provider === 'PinTool Strategies'} />
    <span>{label}</span>
  </div>;
}
