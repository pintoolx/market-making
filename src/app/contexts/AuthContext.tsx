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
  /** 舊欄位；以 status 為準 */
  is_active?: boolean;
  /** public.accounts.status：active | inactive | closed */
  status?: string;
  created_at: string;
  updated_at: string;
  crossmint_wallet_locator: string;
  crossmint_wallet_address: string;
}

interface AuthState {
  /** 是否已完成 Supabase signInWithWeb3 */
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Supabase JWT access_token（用作 Bearer token 給 PinTool API） */
  accessToken: string | null;
  walletAddress: string | null;
  /** 從 public.accounts 查詢到的所有 Crossmint 帳戶 */
  accounts: Account[];
  /** 從 public.canvases 查詢到的草稿 */
  canvases: CanvasData[];
  /** canvases 是否已從 DB 載入完成（區分「還沒載」vs「確實為空」） */
  canvasesLoaded: boolean;
  /** 是否已兌換邀請碼（首次登入必填） */
  hasRedeemedReferral: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /**
   * Part 1: Sign In（身分驗證）
   * 使用 supabase.auth.signInWithWeb3()
   * Supabase 自動產生 challenge、驗證簽名、建立 auth.users
   */
  signIn: () => Promise<void>;
  /** 登出 Supabase session */
  signOut: () => Promise<void>;
  /**
   * Part 2: 取得業務 challenge 簽名
   * 用於需要額外授權的操作（init/delete/export wallet）
   * 回傳 signature (base58 string)
   */
  getBusinessSignature: () => Promise<string>;
  /** 重新從 Supabase 查詢 accounts 資料 */
  refreshAccounts: () => Promise<void>;
  /** 重新從 Supabase 查詢 canvases 草稿 */
  refreshCanvases: () => Promise<void>;
  /** 標記邀請碼已兌換（寫入 localStorage） */
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

  // 從 Supabase public.accounts 查詢所有既有帳戶
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

  // 從 Supabase public.canvases 查詢所有草稿
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

  // 初始化：檢查既有 Supabase session
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

  // 監聽 Supabase auth 狀態變化
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
        // Supabase 自動刷新 token
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

  // 當錢包斷開時自動登出
  useEffect(() => {
    if (!wallet.connected && state.isAuthenticated) {
      handleSignOut();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected]);

  /**
   * Part 1: Sign In
   * 使用 supabase.auth.signInWithWeb3()
   * Supabase 自動處理 challenge、簽名驗證、user 建立
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

      // 用戶拒絕簽名 - 靜默處理
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
   * 登出
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
   * Part 2: 取得業務 challenge 簽名
   * 每次重要操作都向 PinTool API 取新 challenge + 錢包簽名
   * 回傳 signature (base58 string)
   */
  const handleGetBusinessSignature = useCallback(async (): Promise<string> => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signMessage) {
      throw new Error('Wallet not connected');
    }

    const walletAddress = wallet.publicKey.toString();

    // 向 PinTool API 取得業務 challenge
    const challengeRes = await getChallenge(walletAddress);
    const challengeMessage = challengeRes.data.challenge;

    // 用錢包簽名
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
