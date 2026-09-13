import { redirect } from 'next/navigation';

// Preserve older bookmarks while identity management lives with the account.
export default function EnsPage() {
  redirect('/profile?tab=account');
}
