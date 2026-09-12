import { notFound } from 'next/navigation';

export default async function EnsSetupPage() {
  // The .dev.tsx route is only discovered in development; also fail closed here.
  if (process.env.NODE_ENV !== 'development') notFound();
  const { default: EnsSetupClient } = await import('./EnsSetupClient');
  return <EnsSetupClient />;
}
