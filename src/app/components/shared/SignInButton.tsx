'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { User, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import Image from 'next/image';
import Primary from './Primary';

import styles from './SignInButton.module.css';

// Inline shopping-bag icon — uses currentColor so it picks up
// the same default→hover colour swap as the lucide X icon.
function ShoppingBagIcon({ className }: { className?: string }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="M6 2L3 6V20C3 20.5304 3.21071 21.0391 3.58579 21.4142C3.96086 21.7893 4.46957 22 5 22H19C19.5304 22 20.0391 21.7893 20.4142 21.4142C20.7893 21.0391 21 20.5304 21 20V6L18 2H6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 6H21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 14C16 15.0609 15.5786 16.0783 14.8284 16.8284C14.0783 17.5786 13.0609 18 12 18C10.9391 18 9.92172 17.5786 9.17157 16.8284C8.42143 16.0783 8 15.0609 8 14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10" r="1" fill="currentColor" />
      <circle cx="16" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

type SignInButtonProps = {
  /** 已登入時取代錢包截斷顯示（例如 Dashboard 設計稿的 PinTool.sol） */
  authenticatedWalletLabel?: string;
};

export default function SignInButton({ authenticatedWalletLabel }: SignInButtonProps = {}) {
  const wallet = useWallet();
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading: authLoading, error: authError, signIn, signOut } = useAuth();
  const [signInMessage, setSignInMessage] = useState<string>('');
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);

  // 顯示 auth error
  useEffect(() => {
    if (authError) {
      setSignInMessage(`Sign in failed: ${authError}`);
      const timer = setTimeout(() => setSignInMessage(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [authError]);

  // 獲取 SOL 餘額
  useEffect(() => {
    const fetchBalance = async () => {
      if (wallet.publicKey && isAuthenticated) {
        try {
          const connection = new Connection('https://api.devnet.solana.com');
          const balance = await connection.getBalance(wallet.publicKey);
          setSolBalance(balance / LAMPORTS_PER_SOL);
        } catch (error) {
          console.error('Error fetching balance:', error);
          setSolBalance(null);
        }
      } else {
        setSolBalance(null);
      }
    };

    fetchBalance();

    // 每 30 秒更新一次餘額
    const interval = setInterval(fetchBalance, 30000);

    return () => clearInterval(interval);
  }, [wallet.publicKey, isAuthenticated]);

  const handleSignIn = async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setSignInMessage('Please connect a wallet first');
      setTimeout(() => setSignInMessage(''), 3000);
      return;
    }

    setSignInMessage('Please sign the message in your wallet...');

    try {
      await signIn();
      setSignInMessage('');
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) {
        setSignInMessage('');
        return;
      }
      // AuthContext 已處理 error 狀態，這裡不需要額外處理
    }
  };

  const handleSignOut = async () => {
    setIsMenuOpen(false);
    await signOut();
    setSignInMessage('');
  };

  const goToMyWorkflows = () => {
    setIsMenuOpen(false);
    router.push('/workflows');
  };

  const goToCanvas = () => {
    setIsMenuOpen(false);
    router.push('/');
  };

  const goToMarketplace = () => {
    setIsMenuOpen(false);
    router.push('/marketplace');
  };

  const onWorkflowsPage = Boolean(pathname?.startsWith('/workflows'));
  const onMarketplacePage = Boolean(pathname?.startsWith('/marketplace'));

  const openMenu = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setIsMenuOpen(true);
  };

  const closeMenuWithDelay = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
    }
    hoverTimer.current = window.setTimeout(() => {
      setIsMenuOpen(false);
      hoverTimer.current = null;
    }, 150);
  };

  return (
    <div className={styles.signInContainer} ref={containerRef}>
      {!isAuthenticated ? (
        <div className={styles.connectedState}>
          {wallet.connected && wallet.publicKey ? (
            <button
              onClick={handleSignIn}
              className={styles.signInButton}
              disabled={authLoading}
            >
              {authLoading ? 'Signing in...' : 'Connect Wallet'}
            </button>
          ) : (
            <WalletMultiButton className={styles.walletButton} />
          )}
        </div>
      ) : (
        <div className={styles.connectedState}>
          <div
            className={styles.walletMenuAnchor}
            onMouseEnter={openMenu}
            onMouseLeave={closeMenuWithDelay}
          >
            <Primary type="button" className={styles.walletAddressPrimary}>
              <span className={styles.walletAddressRow}>
                <span className={styles.headerIconBox} aria-hidden>
                  <User size={16} strokeWidth={2} />
                </span>
                <span className={styles.walletAddressText}>
                  {authenticatedWalletLabel ??
                    `${wallet.publicKey?.toString().slice(0, 4)}...${wallet.publicKey?.toString().slice(-4)}`}
                </span>
              </span>
            </Primary>
            {isMenuOpen && (
              <div className={styles.dropdownMenu} role="menu">
                <div className={styles.menuBalanceRow}>
                  <span className={styles.menuIconBox} aria-hidden>
                    <Image src="/solana.svg" alt="Solana" width={20} height={20} />
                  </span>
                  <span className={styles.menuLabel}>
                    {solBalance !== null ? `${solBalance.toFixed(2)} SOL` : '...'}
                  </span>
                </div>
                <div className={styles.menuDivider} aria-hidden />
                {onWorkflowsPage ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={goToCanvas}
                  >
                    <span className={styles.menuCanvasIcon} aria-hidden>
                      <img src="/logo.svg" alt="" />
                      <img src="/logo.svg" alt="" />
                      <img src="/logo.svg" alt="" />
                      <img src="/logo.svg" alt="" />
                    </span>
                    <span className={styles.menuLabel}>Canvas</span>
                  </button>
                ) : (
                  <button type="button" role="menuitem" className={styles.menuItem} onClick={goToMyWorkflows}>
                    <img
                      src="/logo.svg"
                      alt=""
                      width={28}
                      height={28}
                      className={styles.menuItemLogo}
                    />
                    <span className={styles.menuLabel}>My Workflows</span>
                  </button>
                )}
                {!onMarketplacePage && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={goToMarketplace}
                  >
                    <ShoppingBagIcon className={styles.menuItemIcon} />
                    <span className={styles.menuLabel}>Marketplace</span>
                  </button>
                )}
                <div className={styles.menuDivider} aria-hidden />
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => void handleSignOut()}
                >
                  <X className={styles.menuItemIcon} size={28} strokeWidth={2} aria-hidden />
                  <span className={styles.menuLabel}>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      
      {signInMessage && (
        <div className={styles.signInMessage}>
          {signInMessage}
        </div>
      )}
    </div>
  );
}
