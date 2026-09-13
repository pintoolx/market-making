'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { supabase, ensureJwtWalletClaimForWorkflowsRls } from '../lib/supabase';
import { getChallenge } from '../lib/pintoolApi';
import { CanvasData } from '../lib/workflowService';

// ─── Types ───────────────────────────────────────────────

export interface Account {
  id: string;
  owner_wallet_address: string;
  name: string;
  current_workflow_id: string | null;
  /** Legacy field; prefer status. */
  is_active?: boolean;
  /** public.accounts.status：active | inactive | closed */
  status?: string;
  created_at: string;
  updated_at: string;
  crossmint_wallet_locator: string;
  crossmint_wallet_address: string;
}

interface AuthState {
  /** Whether Supabase signInWithWeb3 has completed. */
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Supabase JWT access_token, used as the PinTool API Bearer token. */
  accessToken: string | null;
  walletAddress: string | null;
  /** All Crossmint accounts read from public.accounts. */
  accounts: Account[];
  /** Drafts read from public.canvases. */
  canvases: CanvasData[];
  /** Whether canvas loading is complete; distinguish loading from an empty result. */
  canvasesLoaded: boolean;
  /** Whether the required first-login invite code has been redeemed. */
  hasRedeemedReferral: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /**
   * Part 1: Sign In (identity verification).
   * Uses supabase.auth.signInWithWeb3().
   * Supabase creates the challenge, verifies the signature and creates auth.users.
   */
  signIn: () => Promise<void>;
  /** Sign out of the Supabase session. */
  signOut: () => Promise<void>;
  /**
   * Part 2: Obtain a signed business-operation challenge.
   * Used for actions needing additional authorization: init/delete/export wallet.
   * Returns a base58 signature string.
   */
  getBusinessSignature: () => Promise<string>;
  /** Refresh accounts from Supabase. */
  refreshAccounts: () => Promise<void>;
  /** Refresh canvas drafts from Supabase. */
  refreshCanvases: () => Promise<void>;
  /** Mark an invite code redeemed in localStorage. */
  setReferralRedeemed: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────

function getReferralKey(addr: string) {
  return `referralRedeemed:${addr}`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    accessToken: null,
    walletAddress: null,
    accounts: [],
    canvases: [],
    canvasesLoaded: false,
    hasRedeemedReferral: false,
    error: null,
  });
  const isSigningIn = useRef(false);

  // Read all existing accounts from Supabase public.accounts.
  const fetchAccounts = useCallback(async (ownerAddress: string) => {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('owner_wallet_address', ownerAddress)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to fetch accounts:', error.message);
        return;
      }

      setState(prev => ({ ...prev, accounts: (data as Account[]) || [] }));
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, []);

  // Read all drafts from Supabase public.canvases.
  const fetchCanvases = useCallback(async (ownerAddress: string) => {
    try {
      const { data, error } = await supabase
        .from('canvases')
        .select('*')
        .eq('owner_wallet_address', ownerAddress)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to fetch canvases:', error.message);
        return;
      }

      setState(prev => ({ ...prev, canvases: (data as CanvasData[]) || [], canvasesLoaded: true }));
    } catch (err) {
      console.error('Failed to fetch canvases:', err);
      setState(prev => ({ ...prev, canvasesLoaded: true }));
    }
  }, []);

  // Initialize by checking the existing Supabase session.
  useEffect(() => {
    const checkSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          const addr = wallet.publicKey?.toString() || null;
          const redeemed = addr ? localStorage.getItem(getReferralKey(addr)) === 'true' : false;
          let accessToken = session.access_token;
          if (addr) {
            await ensureJwtWalletClaimForWorkflowsRls(addr);
            const { data: { session: afterClaim } } = await supabase.auth.getSession();
            if (afterClaim?.access_token) accessToken = afterClaim.access_token;
          }
          setState(prev => ({
            ...prev,
            isAuthenticated: true,
            isLoading: false,
            accessToken,
            walletAddress: addr,
            hasRedeemedReferral: redeemed,
            error: null,
          }));
          if (addr) {
            fetchAccounts(addr);
            fetchCanvases(addr);
          }
        } else {
          setState(prev => ({ ...prev, isLoading: false }));
        }
      } catch {
        setState(prev => ({ ...prev, isLoading: false }));
      }
    };

    checkSession();
  }, [wallet.publicKey, fetchAccounts, fetchCanvases]);

  // Observe Supabase authentication changes.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setState(prev => ({
          ...prev,
          isAuthenticated: false,
          accessToken: null,
          walletAddress: null,
          accounts: [],
          canvases: [],
          canvasesLoaded: false,
          hasRedeemedReferral: false,
          error: null,
        }));
      } else if (event === 'SIGNED_IN' && session) {
        setState(prev => ({
          ...prev,
          isAuthenticated: true,
          accessToken: session.access_token,
          isLoading: false,
        }));
      } else if (event === 'TOKEN_REFRESHED' && session) {
        // Supabase refreshes the token automatically.
        setState(prev => ({
          ...prev,
          accessToken: session.access_token,
        }));
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Sign out automatically when the wallet disconnects.
  useEffect(() => {
    if (!wallet.connected && state.isAuthenticated) {
      handleSignOut();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected]);

  /**
   * Part 1: Sign In
   * Uses supabase.auth.signInWithWeb3().
   * Supabase handles challenges, signature verification and user creation.
   */
  const handleSignIn = useCallback(async () => {
    if (isSigningIn.current) return;
    if (!wallet.connected || !wallet.publicKey) {
      setState(prev => ({ ...prev, error: 'Please connect a wallet first' }));
      return;
    }

    isSigningIn.current = true;
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const { data, error } = await supabase.auth.signInWithWeb3({
        chain: 'solana',
        statement: 'I accept the Terms of Service at https://pintool.fun/tos',
      });

      if (error) throw error;

      const session = data.session;
      const addr = wallet.publicKey.toString();
      await ensureJwtWalletClaimForWorkflowsRls(addr);
      const { data: { session: latest } } = await supabase.auth.getSession();
      const accessToken = latest?.access_token ?? session?.access_token ?? null;
      const redeemed = localStorage.getItem(getReferralKey(addr)) === 'true';
      setState({
        isAuthenticated: true,
        isLoading: false,
        accessToken,
        walletAddress: addr,
        accounts: [],
        canvases: [],
        canvasesLoaded: false,
        hasRedeemedReferral: redeemed,
        error: null,
      });
      fetchAccounts(addr);
      fetchCanvases(addr);
    } catch (err) {
      const message = (err as Error).message;

      // Handle a user-declined signature without an error notification.
      if (message.includes('rejected') || message.includes('User rejected')) {
        setState(prev => ({ ...prev, isLoading: false, error: null }));
        return;
      }

      setState(prev => ({
        ...prev,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
        error: message,
      }));
    } finally {
      isSigningIn.current = false;
    }
  }, [wallet, fetchAccounts, fetchCanvases]);

  /**
   * Sign out.
   */
  const handleSignOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
    setState({
      isAuthenticated: false,
      isLoading: false,
      accessToken: null,
      walletAddress: null,
      accounts: [],
      canvases: [],
      canvasesLoaded: false,
      hasRedeemedReferral: false,
      error: null,
    });
  }, []);

  /**
   * Part 2: Obtain a signed business-operation challenge.
   * Request a fresh PinTool API challenge and wallet signature for each sensitive action.
   * Returns a base58 signature string.
   */
  const handleGetBusinessSignature = useCallback(async (): Promise<string> => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signMessage) {
      throw new Error('Wallet not connected');
    }

    const walletAddress = wallet.publicKey.toString();

    // Obtain the business-operation challenge from the PinTool API.
    const challengeRes = await getChallenge(walletAddress);
    const challengeMessage = challengeRes.data.challenge;

    // Sign with the wallet.
    const messageBytes = new TextEncoder().encode(challengeMessage);
    const signatureBytes = await wallet.signMessage(messageBytes);
    return bs58.encode(signatureBytes);
  }, [wallet]);

  const handleRefreshAccounts = useCallback(async () => {
    if (state.walletAddress) {
      await fetchAccounts(state.walletAddress);
    }
  }, [state.walletAddress, fetchAccounts]);

  const handleRefreshCanvases = useCallback(async () => {
    if (state.walletAddress) {
      await fetchCanvases(state.walletAddress);
    }
  }, [state.walletAddress, fetchCanvases]);

  const handleSetReferralRedeemed = useCallback(() => {
    if (state.walletAddress) {
      localStorage.setItem(getReferralKey(state.walletAddress), 'true');
    }
    setState(prev => ({ ...prev, hasRedeemedReferral: true }));
  }, [state.walletAddress]);

  const value = useMemo<AuthContextValue>(() => ({
    ...state,
    signIn: handleSignIn,
    signOut: handleSignOut,
    getBusinessSignature: handleGetBusinessSignature,
    refreshAccounts: handleRefreshAccounts,
    refreshCanvases: handleRefreshCanvases,
    setReferralRedeemed: handleSetReferralRedeemed,
  }), [state, handleSignIn, handleSignOut, handleGetBusinessSignature, handleRefreshAccounts, handleRefreshCanvases, handleSetReferralRedeemed]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
