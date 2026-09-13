'use client';

import { useConnectWallet, usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, toHex, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';
import { PRIVY_APP_ID } from './PrivyProvider';

export type Account = {
  /** Login is configured (Privy app id present). When false, flows run without an account. */
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  connectWallet?: () => void;
  userId?: string;
  email?: string;
  address?: string;
  /** Every Ethereum wallet linked to this Privy user, including external wallets. */
  addresses: string[];
  /** Wallet was created by Privy for an email login, so it starts empty. */
  embedded: boolean;
  walletConnected: boolean;
  /** e.g. "Email" or "Wallet". */
  method: string;
  signMessage?: (message: string) => Promise<`0x${string}`>;
  getAccessToken?: () => Promise<string | null>;
  ensWallet?: () => Promise<WalletClient>;
  evmWallet?: (address?: string) => Promise<WalletClient>;
};

function usePrivyAccount(): Account {
  const { ready, authenticated, login, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const email = user?.email?.address;
  const linkedWallets = user?.linkedAccounts.flatMap(account =>
    account.type === 'wallet' && account.chainType === 'ethereum'
      ? [account.address]
      : []
  ) ?? [];
  const addresses = [...new Set([user?.wallet?.address, ...linkedWallets].filter((address): address is string => Boolean(address)))];
  const walletConnected = wallets.some(item => item.address.toLowerCase() === user?.wallet?.address?.toLowerCase());

  // Privy marks its embedded wallet as "privy"; any other client type means the user connected their own wallet.
  const embedded = user?.wallet?.walletClientType === 'privy';
  // Product-neutral label: platform logic doesn't depend on the exact wallet brand.
  const method = user?.wallet && !embedded ? 'Wallet' : email ? 'Email' : 'Unknown';

  const signMessage = async (message: string): Promise<`0x${string}`> => {
    const wallet = wallets.find(item => item.address.toLowerCase() === user?.wallet?.address?.toLowerCase());
    if (!wallet) throw new Error('Connect your Provider wallet before signing.');
    const provider = await wallet.getEthereumProvider();
    const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Wallet returned an invalid signature.');
    return signature as `0x${string}`;
  };

  const evmWallet = async (address = user?.wallet?.address): Promise<WalletClient> => {
    const wallet = wallets.find(item => item.address.toLowerCase() === address?.toLowerCase());
    if (!wallet) throw new Error('Connect the selected Ethereum wallet before continuing.');
    await wallet.switchChain(sepolia.id);
    const provider = await wallet.getEthereumProvider();
    return createWalletClient({ account: wallet.address as `0x${string}`, chain: sepolia, transport: custom(provider) });
  };

  const ensWallet = () => evmWallet();

  return {
    enabled: true,
    ready,
    authenticated,
    login,
    connectWallet,
    userId: user?.id,
    email,
    address: user?.wallet?.address,
    addresses,
    embedded,
    walletConnected,
    method,
    signMessage,
    getAccessToken,
    ensWallet,
    evmWallet,
  };
}

function useNoAccount(): Account {
  return { enabled: false, ready: true, authenticated: false, login: () => {}, addresses: [], embedded: false, walletConnected: false, method: 'Unknown' };
}

// PRIVY_APP_ID is fixed at build time, so the same hook runs on every render.
export const useAccount = PRIVY_APP_ID ? usePrivyAccount : useNoAccount;

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
