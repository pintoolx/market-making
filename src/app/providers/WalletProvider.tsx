'use client';

import React, { useMemo, useCallback } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { SOLANA_RPC_URL } from '../lib/solana';

interface SolanaWalletProviderProps {
  children: React.ReactNode;
}

export default function SolanaWalletProvider({ children }: SolanaWalletProviderProps) {
  const endpoint = useMemo(() => SOLANA_RPC_URL, []);

  // Empty array = auto-detect browser-installed wallets (Phantom, Solflare, MetaMask, etc.)
  const wallets = useMemo(() => [], []);

  const handleWalletError = useCallback((error: unknown) => {
    const name = (error as { name?: string })?.name || '';
    const message = (error as Error)?.message || String(error);
    if (message.includes('User rejected')) return;
    if (name === 'WalletDisconnectedError') return;
    console.error('[WalletAdapterError]', error);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={handleWalletError}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}


