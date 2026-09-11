'use client';

import { PrivyProvider } from '@privy-io/react-auth';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? '';

export default function EthereumPrivyProvider({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) return children;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#2050F2',
          walletChainType: 'ethereum-only',
        },
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
