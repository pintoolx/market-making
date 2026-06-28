'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { StrategyMarketplace } from '../components/Earner/StrategyMarketplace';
import { Strategy } from '../types/strategy';
import {
  getUserWorkflows,
  fetchFirstExecutionStartedAtByWorkflowIds,
  accountLifecycleFromRow,
  updateAccountStatus,
  type WorkflowData,
} from '../lib/workflowService';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/shared/Toast';
import { getInvitedByCode } from '../lib/referralStorage';
import { fetchMyReferralCodes, withdrawWallet } from '../lib/pintoolApi';
import YourInviteCodesModal from '../components/shared/YourInviteCodesModal';
import type { InviteCodeItem } from '../components/shared/YourInviteCodesModal';
import Tertiary from '../components/shared/Tertiary';
import Secondary from '../components/shared/Secondary';
import styles from './page.module.css';

const SignInButton = dynamic(() => import('../components/shared/SignInButton'), {
  ssr: false,
  loading: () => <div style={{ width: '150px', height: '40px' }}></div>,
});

export default function WorkflowsPage() {
  const router = useRouter();
  const wallet = useWallet();
  const {
    isAuthenticated,
    accessToken,
    walletAddress,
    accounts,
    canvases,
    getBusinessSignature,
    refreshAccounts,
  } = useAuth();
  const [invitedByCode, setInvitedByCode] = useState<string | null>(null);
  const [inviteCodesModalOpen, setInviteCodesModalOpen] = useState(false);
  const [myInviteCodes, setMyInviteCodes] = useState<InviteCodeItem[]>([]);
  const [inviteCodesLoaded, setInviteCodesLoaded] = useState(false);
  const { showToast } = useToast();
  const [deployedWorkflows, setDeployedWorkflows] = useState<WorkflowData[]>([]);
  const [firstStartedByWorkflow, setFirstStartedByWorkflow] = useState<Map<string, string>>(
    () => new Map()
  );
  const [isLoading, setIsLoading] = useState(true);
  const [toggleAccountWorkflowId, setToggleAccountWorkflowId] = useState<string | null>(null);

  const connection = useMemo(
    () => new Connection('https://api.devnet.solana.com'),
    []
  );

  const strategies = useMemo((): Strategy[] => {
    return deployedWorkflows.map(w => {
      const account = accounts.find(a => a.current_workflow_id === w.id);
      const life = accountLifecycleFromRow(account);
      return {
        id: w.id || '',
        title: w.name,
        description: w.description || `Created ${new Date(w.created_at || '').toLocaleString()}`,
        creator: 'You',
        category: 'Deployed',
        tags: [],
        rating: 0,
        usageCount: 0,
        isActive: life === 'active',
        accountLifecycle: life,
        capital: 2500,
        pnl: 210,
        healthWarning: 'This strategy has no predefined execution limits, may use your available funds without a cap.',
        deployedAt: w.created_at ?? null,
        firstExecutionStartedAt: w.id ? firstStartedByWorkflow.get(w.id) ?? null : null,
      };
    });
  }, [deployedWorkflows, accounts, firstStartedByWorkflow]);

  // Load deployed workflows from Supabase（與 accounts 分離，避免僅帳戶變更就重打 workflows API）
  useEffect(() => {
    if (!isAuthenticated || !walletAddress) {
      setDeployedWorkflows([]);
      setFirstStartedByWorkflow(new Map());
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const loadWorkflows = async () => {
      try {
        const workflows = await getUserWorkflows(walletAddress);
        const wfIds = workflows.map(w => w.id).filter((id): id is string => Boolean(id));
        const firstMap = await fetchFirstExecutionStartedAtByWorkflowIds(walletAddress, wfIds);
        setDeployedWorkflows(workflows);
        setFirstStartedByWorkflow(firstMap);
      } catch (e) {
        console.warn('Failed to load workflows:', e);
        setDeployedWorkflows([]);
        setFirstStartedByWorkflow(new Map());
      } finally {
        setIsLoading(false);
      }
    };

    void loadWorkflows();
  }, [isAuthenticated, walletAddress]);

  useEffect(() => {
    if (!walletAddress) {
      setInvitedByCode(null);
      return;
    }
    const read = () => setInvitedByCode(getInvitedByCode(walletAddress));
    read();
    const onUpdated = (e: Event) => {
      const w = (e as CustomEvent<{ walletAddress: string }>).detail?.walletAddress;
      if (w === walletAddress) read();
    };
    window.addEventListener('pintool:invitedByUpdated', onUpdated);
    return () => window.removeEventListener('pintool:invitedByUpdated', onUpdated);
  }, [walletAddress]);

  const draftCount = canvases.length;

  const showViewInvites = useMemo(
    () =>
      inviteCodesLoaded &&
      myInviteCodes.length > 0 &&
      myInviteCodes.every(c => c.used),
    [inviteCodesLoaded, myInviteCodes]
  );

  useEffect(() => {
    if (!isAuthenticated || !accessToken || !walletAddress) {
      setMyInviteCodes([]);
      setInviteCodesLoaded(false);
      setInviteCodesModalOpen(false);
    }
  }, [walletAddress, isAuthenticated, accessToken]);

  const openInviteCodesModal = useCallback(async () => {
    setInviteCodesModalOpen(true);
    if (!isAuthenticated || !accessToken) {
      setMyInviteCodes([]);
      setInviteCodesLoaded(false);
      return;
    }
    try {
      const list = await fetchMyReferralCodes(accessToken);
      setMyInviteCodes(list);
      setInviteCodesLoaded(true);
    } catch {
      showToast('Could not load invite codes.', 'warning');
      setMyInviteCodes([]);
      setInviteCodesLoaded(true);
    }
  }, [isAuthenticated, accessToken, showToast]);

  const closeInviteCodesModal = useCallback(() => {
    setInviteCodesModalOpen(false);
  }, []);

  // Edit: navigate to canvas and select the corresponding account tab
  const handleEdit = useCallback(
    (workflowId: string) => {
      const account = accounts.find(a => a.current_workflow_id === workflowId);
      if (account) {
        router.push(`/?tab=${account.id}`);
      } else {
        router.push(`/?workflow=${workflowId}`);
      }
    },
    [accounts, router]
  );

  // Deposit: transfer SOL from connected wallet to Crossmint wallet
  const handleDeposit = useCallback(
    async (workflowId: string) => {
      try {
        if (!wallet.connected || !wallet.publicKey) {
          showToast('Please connect your wallet first.', 'warning');
          return;
        }

        const account = accounts.find(a => a.current_workflow_id === workflowId);
        if (!account?.crossmint_wallet_address) {
          showToast('No Crossmint wallet linked to this strategy.', 'warning');
          return;
        }

        const input = window.prompt('Enter amount of SOL to deposit:');
        if (!input) return;

        const amount = parseFloat(input);
        if (!Number.isFinite(amount) || amount <= 0) {
          showToast('Please enter a valid positive number.', 'warning');
          return;
        }

        const lamports = Math.round(amount * LAMPORTS_PER_SOL);
        const toPubkey = new PublicKey(account.crossmint_wallet_address);

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey,
            lamports,
          })
        );

        const signature = await wallet.sendTransaction(tx, connection);
        showToast('Deposit transaction sent. Confirming...', 'info');

        await connection.confirmTransaction(signature, 'confirmed');
        showToast('Deposit completed successfully.', 'success');
      } catch (err) {
        const message = (err as Error)?.message || String(err);
        if (message.includes('User rejected') || message.includes('rejected')) {
          return;
        }
        console.error('Deposit failed:', err);
        showToast(`Deposit failed: ${message}`, 'error');
      }
    },
    [accounts, wallet, connection, showToast]
  );

  const handleActivate = useCallback(
    async (workflowId: string) => {
      if (!walletAddress) return;
      const account = accounts.find(a => a.current_workflow_id === workflowId);
      if (!account) {
        showToast('此策略尚未綁定執行帳戶，請先在 Creator 建立或綁定帳戶。', 'warning');
        return;
      }
      const life = accountLifecycleFromRow(account);
      if (life === 'closed') {
        showToast('此帳戶已關閉，無法再次啟動。', 'warning');
        return;
      }
      setToggleAccountWorkflowId(workflowId);
      try {
        await updateAccountStatus(walletAddress, account.id, 'active');
        await refreshAccounts();
      } catch (err) {
        console.error('Activate account failed:', err);
        const msg = (err as Error)?.message || String(err);
        showToast(`Could not start: ${msg}`, 'error');
      } finally {
        setToggleAccountWorkflowId(null);
      }
    },
    [walletAddress, accounts, refreshAccounts, showToast]
  );

  const handleDeactivate = useCallback(
    async (workflowId: string) => {
      if (!walletAddress) return;
      const account = accounts.find(a => a.current_workflow_id === workflowId);
      if (!account) return;
      const life = accountLifecycleFromRow(account);
      if (life === 'closed') return;

      setToggleAccountWorkflowId(workflowId);
      try {
        await updateAccountStatus(walletAddress, account.id, 'inactive');
        await refreshAccounts();
        showToast('Strategy paused.', 'success');
      } catch (err) {
        console.error('Pause account failed:', err);
        const msg = (err as Error)?.message || String(err);
        showToast(`Could not pause: ${msg}`, 'error');
      } finally {
        setToggleAccountWorkflowId(null);
      }
    },
    [walletAddress, accounts, refreshAccounts, showToast]
  );

  const handleWithdraw = useCallback(
    async (workflowId: string, amountInput: string) => {
      if (!walletAddress || !accessToken) return;

      const account = accounts.find(a => a.current_workflow_id === workflowId);
      if (!account?.id || !account.crossmint_wallet_address) {
        showToast('No Crossmint wallet linked to this strategy.', 'warning');
        return;
      }

      const amount = Number(amountInput);
      if (!Number.isFinite(amount) || amount <= 0) {
        showToast('Please enter a valid positive number.', 'warning');
        return;
      }

      try {
        const walletPubkey = new PublicKey(account.crossmint_wallet_address);
        const lamports = await connection.getBalance(walletPubkey, 'confirmed');
        const maxWithdrawSol = lamports / LAMPORTS_PER_SOL;

        if (maxWithdrawSol <= 0) {
          showToast('This strategy wallet has no available SOL to withdraw.', 'warning');
          return;
        }

        if (amount > maxWithdrawSol) {
          showToast(`Max withdraw is ${maxWithdrawSol.toFixed(6)} SOL.`, 'warning');
          return;
        }

        const signature = await getBusinessSignature();
        await withdrawWallet(accessToken, account.id, walletAddress, signature, amount);
        await refreshAccounts();
        showToast('Withdraw request submitted successfully.', 'success');
      } catch (err) {
        const message = (err as Error)?.message || String(err);
        if (message.includes('User rejected') || message.includes('rejected')) {
          return;
        }
        console.error('Withdraw failed:', err);
        showToast(`Withdraw failed: ${message}`, 'error');
      }
    },
    [walletAddress, accessToken, accounts, connection, getBusinessSignature, refreshAccounts, showToast]
  );

  const handleArchive = useCallback(
    async (workflowId: string) => {
      if (!walletAddress) return;
      const account = accounts.find(a => a.current_workflow_id === workflowId);
      if (!account) {
        showToast('沒有綁定帳戶可關閉。', 'warning');
        return;
      }
      setToggleAccountWorkflowId(workflowId);
      try {
        await updateAccountStatus(walletAddress, account.id, 'closed');
        await refreshAccounts();
        showToast('帳戶已關閉，此策略不會再啟動。', 'success');
      } catch (err) {
        console.error('Close account failed:', err);
        const msg = (err as Error)?.message || String(err);
        showToast(`無法關閉帳戶: ${msg}`, 'error');
      } finally {
        setToggleAccountWorkflowId(null);
      }
    },
    [walletAddress, accounts, refreshAccounts, showToast]
  );

  return (
    <div className={styles.workflowsPage}>
      {/* Toolbar - same design as home page */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <Image
            src="/pintoolLogo.svg"
            alt="PinTool"
            className={styles.logoImage}
            onClick={() => router.push('/')}
            width={190}
            height={40}
            priority
          />
        </div>
        <div className={styles.toolbarRight}>
          <Link href="/" className={styles.createBtnLink}>
            <Secondary>
              <span className={styles.createBtnInner}>
                <Image
                  src="/plus-square.svg"
                  alt=""
                  width={16}
                  height={16}
                  aria-hidden
                />
                Create
              </span>
            </Secondary>
          </Link>
          <SignInButton />
        </div>
      </div>

      <div className={styles.pageScroll}>
        {/* Portfolio Overview */}
        <div className={styles.portfolioOverview}>
          <div className={styles.portfolioOverviewRow}>
            <div className={styles.avatarBox} aria-hidden>
              <svg className={styles.avatarSvg} width="78" height="79" viewBox="0 0 24 25" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5.44236 24.5122C2.43663 24.5122 -1.06508e-07 22.0756 -2.37893e-07 19.0698L-8.94531e-07 4.04773C-1.10945e-06 -0.869045 7.11699 -1.53049 8.0231 3.30208C8.84823 7.70279 15.1518 7.70279 15.9769 3.30208C16.883 -1.53049 24 -0.869046 24 4.04773L24 19.0698C24 22.0756 21.5634 24.5122 18.5576 24.5122L5.44236 24.5122Z" fill="#2050F2" />
                <path d="M6 16.5122L6.34314 16.8554C9.46734 19.9795 14.5327 19.9795 17.6569 16.8554L18 16.5122" stroke="#E4EAF2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="5" cy="11.5122" r="2" fill="#E4EAF2" />
                <circle cx="19" cy="11.5122" r="2" fill="#E4EAF2" />
              </svg>
            </div>

            <div className={styles.portfolioMiddle}>
              <div className={`${styles.totalValueCard} ${styles.middleCellTopLeft}`}>
                <span className={styles.statLabel}>Total Portfolio Value</span>
                <span className={styles.totalValue}>$100,000,000.01</span>
              </div>
              <div className={`${styles.inviteCard} ${styles.middleCellTopRight}`}>
                <div className={styles.inviteRow}>
                  <span className={styles.inviteLabel}>You were invited by</span>
                  {invitedByCode ? (
                    <button
                      type="button"
                      className={styles.inviteCodeBtn}
                      onClick={openInviteCodesModal}
                    >
                      {invitedByCode}
                    </button>
                  ) : (
                    <span className={styles.inviteCodeMuted}>—</span>
                  )}
                </div>
                <Tertiary
                  fullWidth
                  type="button"
                  className={styles.inviteFriendsTertiary}
                  onClick={() => void openInviteCodesModal()}
                >
                  <span className={styles.inviteFriendsRow}>
                    <span className={styles.inviteFriendsIcon} aria-hidden>
                      <img src="/referral.svg" alt="" width={16} height={16} />
                    </span>
                    <span>{showViewInvites ? 'View Invites' : 'Invite Friends'}</span>
                  </span>
                </Tertiary>
              </div>
              <div className={`${styles.statsRow} ${styles.middleCellBottomLeft}`}>
                <div className={styles.statCard}>
                  <span className={styles.statLabel}>Available</span>
                  <span className={styles.statValue}>$3,200</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statLabel}>Weekly PnL</span>
                  <span className={styles.statValueGreen}>+$340</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statLabel}>Total Strategy PnL</span>
                  <span className={styles.statValueGreen}>+$1,420</span>
                </div>
              </div>
              <div className={`${styles.statusCard} ${styles.middleCellBottomRight}`}>
                <span className={styles.statLabel}>Strategy Status</span>
                <div className={styles.statusDots}>
                  <div className={styles.statusItem}>
                    <span className={styles.dotActive} />
                    <span className={styles.statusText}>Active</span>
                    <span className={styles.statusText}>&nbsp;{strategies.filter(s => s.isActive).length}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.dotPaused} />
                    <span className={styles.statusText}>Paused</span>
                    <span className={styles.statusText}>&nbsp;{strategies.filter(s => !s.isActive).length}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.dotDraft} />
                    <span className={styles.statusText}>Draft</span>
                    <span className={styles.statusText}>&nbsp;{draftCount}</span>
                  </div>
                </div>
              </div>
            </div>
        </div>
      </div>

      {/* Main Content */}
      <div className={styles.mainContent}>
        <StrategyMarketplace
          strategies={strategies}
          onStrategyActivate={handleActivate}
          onStrategyDeactivate={handleDeactivate}
          onStrategyEdit={handleEdit}
          onStrategyDeposit={handleDeposit}
          onStrategyWithdraw={handleWithdraw}
          onStrategyArchive={handleArchive}
          activatingId={toggleAccountWorkflowId}
          isLoading={isLoading}
        />
      </div>
      </div>

      <YourInviteCodesModal
        open={inviteCodesModalOpen}
        onClose={closeInviteCodesModal}
        codes={myInviteCodes}
      />
    </div>
  );
}
