// Single source of truth for the Solana cluster the app talks to.
// Override per environment with NEXT_PUBLIC_SOLANA_RPC_URL (baked at build time).
export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
