import { createClient } from '@supabase/supabase-js';

// Supabase configuration - these values should be set in your .env file
// For development without Supabase, we provide dummy values
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';

// Debug: Log the configuration (only in development)
if (process.env.NODE_ENV === 'development') {
  console.log('🔧 Supabase Config:', {
    url: supabaseUrl,
    hasAnonKey: !!supabaseAnonKey && supabaseAnonKey !== 'placeholder-key',
    isConfigured: supabaseUrl !== 'https://placeholder.supabase.co'
  });
}

// Create Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

function readJwtUserMetadataCustomClaimsAddress(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const um = payload.user_metadata;
    if (!um || typeof um !== 'object' || um === null) return null;
    const cc = (um as Record<string, unknown>).custom_claims;
    if (!cc || typeof cc !== 'object' || cc === null) return null;
    const a = (cc as Record<string, unknown>).address;
    return a != null && a !== '' ? String(a) : null;
  } catch {
    return null;
  }
}

/**
 * When RLS on workflows and related tables uses
 * `owner_wallet_address = (auth.jwt()->'user_metadata'->'custom_claims'->>'address')`，
 * Web3 JWTs may lack this nested field. Populate user_metadata and refreshSession because RLS reads the JWT.
 */
export async function ensureJwtWalletClaimForWorkflowsRls(walletAddress: string): Promise<void> {
  if (!walletAddress.trim()) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return;

  if (readJwtUserMetadataCustomClaimsAddress(session.access_token) === walletAddress) {
    return;
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return;

  const meta = (user.user_metadata || {}) as Record<string, unknown>;
  const rawCustom = meta.custom_claims;
  const custom =
    rawCustom && typeof rawCustom === 'object' && rawCustom !== null
      ? { ...(rawCustom as Record<string, unknown>) }
      : {};
  const dbAddr = custom.address != null ? String(custom.address) : '';

  if (dbAddr !== walletAddress) {
    custom.address = walletAddress;
    const { error: updError } = await supabase.auth.updateUser({
      data: { custom_claims: custom },
    });
    if (updError) {
      console.warn('[auth] sync user_metadata.custom_claims.address failed:', updError.message);
      return;
    }
  }

  const { error: refError } = await supabase.auth.refreshSession();
  if (refError) {
    console.warn('[auth] refreshSession after wallet claim sync failed:', refError.message);
  }
}

// Check if Supabase is properly configured
export const isSupabaseConfigured = () => {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_URL !== undefined &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined &&
    supabaseUrl !== 'https://placeholder.supabase.co'
  );
};

