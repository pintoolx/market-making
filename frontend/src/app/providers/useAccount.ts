'use client';

import { usePrivy, useWallets } from '@privy-io/react-auth';
import { toHex } from 'viem';
import { PRIVY_APP_ID } from './PrivyProvider';

export type Account = {
  /** Login is configured (Privy app id present). When false, flows run without an account. */
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  userId?: string;
  email?: string;
  address?: string;
  /** Wallet was created by Privy for an email login, so it starts empty. */
  embedded: boolean;
  /** e.g. "Email" or "Wallet · MetaMask". */
  method: string;
  signMessage?: (message: string) => Promise<`0x${string}`>;
};

const WALLET_NAMES: Record<string, string> = { metamask: 'MetaMask', coinbase_wallet: 'Coinbase Wallet', rainbow: 'Rainbow', wallet_connect: 'WalletConnect', rabby_wallet: 'Rabby', okx_wallet: 'OKX Wallet', phantom: 'Phantom' };
const walletName = (type: string) => WALLET_NAMES[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function usePrivyAccount(): Account {
  const { ready, authenticated, login, user } = usePrivy();
  const { wallets } = useWallets();
  const email = user?.email?.address;
  // Privy marks its embedded wallet as "privy"; any other client type means the user connected their own wallet.
  const embedded = user?.wallet?.walletClientType === 'privy';
  const method = user?.wallet && !embedded ? `Wallet · ${walletName(user.wallet.walletClientType ?? 'wallet')}` : email ? 'Email' : 'Unknown';
  const signMessage = async (message: string): Promise<`0x${string}`> => {
    const wallet = wallets.find(item => item.address.toLowerCase() === user?.wallet?.address?.toLowerCase());
    if (!wallet) throw new Error('Connect your Provider wallet before signing.');
    const provider = await wallet.getEthereumProvider();
    const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Wallet returned an invalid signature.');
    return signature as `0x${string}`;
  };
  return { enabled: true, ready, authenticated, login, userId: user?.id, email, address: user?.wallet?.address, embedded, method, signMessage };
}

function useNoAccount(): Account {
  return { enabled: false, ready: true, authenticated: false, login: () => {}, embedded: false, method: 'Unknown' };
}

// PRIVY_APP_ID is fixed at build time, so the same hook runs on every render.
export const useAccount = PRIVY_APP_ID ? usePrivyAccount : useNoAccount;

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
