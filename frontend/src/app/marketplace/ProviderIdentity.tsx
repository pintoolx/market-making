'use client';

import Avatar from '../components/shared/Avatar';
import CopyAddress from '../profile/CopyAddress';
import type { Listing } from './publishedStore';
import aqua from './aqua.module.css';

export default function ProviderIdentity({ listing }: { listing: Listing }) {
  if (!listing.provider) return null;
  const address = /^0x[0-9a-f]{40}$/i.test(listing.provider);
  const label = listing.providerName ?? (address ? `${listing.provider.slice(0, 6)}…${listing.provider.slice(-4)}` : listing.provider);
  return <div className={`${aqua.byline} ${aqua.providerIdentity}`}>
    <Avatar name={label} src={listing.providerAvatar} size={28} brand={listing.provider === 'PinTool Strategies'} />
    <span>{listing.providerName ?? (!address ? label : '')}</span>
    {address && <CopyAddress key={listing.provider} address={listing.provider} short />}
  </div>;
}
