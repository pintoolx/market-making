import { redirect } from 'next/navigation';

// The ETHOnline flow moved to /, /studio and /maker.
export default function MarketplaceRedirect() {
  redirect('/');
}
