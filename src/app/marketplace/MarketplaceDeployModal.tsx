'use client';

/**
 * Marketplace strategy activation modal.
 *
 * Visually identical to WorkflowBuilder's Deploy overlay (Step 2 onwards).
 * Reuses WorkflowBuilder.module.css for visuals and the same Solana / Supabase
 * calls as the canvas Deploy flow, but skips Step 1 (the name is supplied by
 * the marketplace strategy) and the canvas/tab management bits.
 *
 * Flow: Deploy Ready! → Active Ready! → Successful! / Failed!
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletSendTransactionError } from '@solana/wallet-adapter-base';
import {
  Connection as SolanaConnection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/shared/Toast';
import FormInput from '../components/shared/FormInput';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import { createWorkflow, createCanvas } from '../lib/workflowService';
import { initWallet } from '../lib/pintoolApi';
import { supabase } from '../lib/supabase';

// 共用 deploy modal 的 Figma 外觀；直接從 WorkflowBuilder 模組借樣式
import styles from '../components/Creator/WorkflowBuilder.module.css';

const SOL_USD_DISPLAY_APPROX = 80;
const RENT_TOP_UP_BUFFER_LAMPORTS = 1_000_000;

type WalletTransferFns = {
  sendTransaction: (
    transaction: Transaction,
    connection: SolanaConnection,
    options?: Record<string, unknown>
  ) => Promise<string>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
};

function formatSolTransferError(err: unknown): string {
  if (err instanceof WalletSendTransactionError) {
    if (err.error) {
      const inner = err.error as { message?: string };
      if (inner?.message && inner.message !== 'Unexpected error') return inner.message;
    }
    if (!err.message || err.message === 'Unexpected error') {
      return 'Wallet blocked send (often: wallet is on a different cluster than this app). Switch your wallet to Mainnet, the same cluster as this app.';
    }
  }
  const m = (err as Error)?.message;
  if (m && m !== 'Unexpected error') return m;
  return 'Transaction failed. Make sure your wallet is on Mainnet with enough SOL for amount + fees.';
}

async function assertTransferSimulationOk(
  connection: SolanaConnection,
  tx: Transaction
): Promise<void> {
  const { value } = await connection.simulateTransaction(tx);
  if (value.err) {
    const tail = value.logs?.slice(-8).join(' | ') ?? '';
    throw new Error(
      `Simulation: ${JSON.stringify(value.err)}${tail ? ` — ${tail}` : ''}`
    );
  }
}

async function signAndSendLegacyTransfer(
  wallet: WalletTransferFns,
  connection: SolanaConnection,
  transaction: Transaction
): Promise<string> {
  await assertTransferSimulationOk(connection, transaction);
  if (typeof wallet.signTransaction === 'function') {
    const signed = await wallet.signTransaction(transaction);
    return connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
  return wallet.sendTransaction(transaction, connection);
}

async function getRentTopUpLamports(
  connection: SolanaConnection,
  toPubkey: PublicKey
): Promise<{
  minRentLamports: number;
  minExtraLamports: number;
  requiredSendLamports: number;
}> {
  const minRentLamports = await connection.getMinimumBalanceForRentExemption(0);
  const currentLamports = await connection.getBalance(toPubkey);
  const minExtraLamports = Math.max(0, minRentLamports - currentLamports);
  const requiredSendLamports =
    minExtraLamports === 0 ? 0 : minExtraLamports + RENT_TOP_UP_BUFFER_LAMPORTS;
  return { minRentLamports, minExtraLamports, requiredSendLamports };
}

function formatSolAmountForHint(sol: number): string {
  const t = sol.toFixed(6);
  return t.replace(/\.?0+$/, '') || '0';
}

function rentShortfallHintText(minExtraLamports: number): string {
  return `Please add at least ${formatSolAmountForHint(
    minExtraLamports / LAMPORTS_PER_SOL
  )} SOL to continue`;
}

interface MarketplaceDeployModalProps {
  strategyName: string;
  onClose: () => void;
  onActivated?: () => void;
}

export default function MarketplaceDeployModal({
  strategyName,
  onClose,
  onActivated,
}: MarketplaceDeployModalProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const wallet = useWallet();
  const { connection: solanaConnection } = useConnection();
  const {
    isAuthenticated,
    accessToken,
    walletAddress,
    getBusinessSignature,
    refreshAccounts,
    refreshCanvases,
  } = useAuth();

  const canActivate = isAuthenticated;

  // ── State ──────────────────────────────────────────────────────────
  const [deployFundAmount, setDeployFundAmount] = useState('');
  const [deployFundRentError, setDeployFundRentError] = useState<string | null>(null);
  const [deployStep2MinRentLamports, setDeployStep2MinRentLamports] = useState<number | null>(
    null
  );
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [deploySuccessFunded, setDeploySuccessFunded] = useState(false);
  const [deploySuccessBalanceSol, setDeploySuccessBalanceSol] = useState(0);
  const [deploySuccessUsdApprox, setDeploySuccessUsdApprox] = useState(0);
  const [deployFundedUiPhase, setDeployFundedUiPhase] = useState<'success' | 'redirect'>(
    'success'
  );
  const [deployErrorMessage, setDeployErrorMessage] = useState<string | null>(null);
  const [postSuccessFundInput, setPostSuccessFundInput] = useState('');
  const [postSuccessFundRentError, setPostSuccessFundRentError] = useState<string | null>(null);
  const [postSuccessFunding, setPostSuccessFunding] = useState(false);
  const [postSuccessActivating, setPostSuccessActivating] = useState(false);
  const [deployAutoRedirectToWorkflows, setDeployAutoRedirectToWorkflows] = useState(false);

  const deployStep2RentSeqRef = useRef(0);
  const postSuccessRentSeqRef = useRef(0);
  const postSuccessFundInputRef = useRef<HTMLInputElement>(null);
  const deployCrossmintAddrRef = useRef<string | null>(null);
  const deployAccountIdRef = useRef<string | null>(null);
  const deployFundedNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deployFundedNavTimer2Ref = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeployFundedAutoNavTimers = useCallback(() => {
    if (deployFundedNavTimerRef.current) {
      clearTimeout(deployFundedNavTimerRef.current);
      deployFundedNavTimerRef.current = null;
    }
    if (deployFundedNavTimer2Ref.current) {
      clearTimeout(deployFundedNavTimer2Ref.current);
      deployFundedNavTimer2Ref.current = null;
    }
    setDeployAutoRedirectToWorkflows(false);
    setDeployFundedUiPhase('success');
  }, []);

  // ── Effects ────────────────────────────────────────────────────────
  // Lock body scroll while modal is open
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Compute Step 2 rent-exempt minimum (assume zero balance pre-deploy)
  useEffect(() => {
    let cancelled = false;
    const seq = ++deployStep2RentSeqRef.current;
    (async () => {
      try {
        const min = await solanaConnection.getMinimumBalanceForRentExemption(0);
        if (!cancelled && seq === deployStep2RentSeqRef.current) {
          setDeployStep2MinRentLamports(min + RENT_TOP_UP_BUFFER_LAMPORTS);
        }
      } catch {
        if (!cancelled && seq === deployStep2RentSeqRef.current) {
          setDeployStep2MinRentLamports(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [solanaConnection]);

  // Step 2 fund-amount validation
  useEffect(() => {
    if (deployStep2MinRentLamports == null) return;
    const raw = deployFundAmount.trim();
    if (!raw) {
      setDeployFundRentError(null);
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setDeployFundRentError(null);
      return;
    }
    const lamports = Math.round(n * LAMPORTS_PER_SOL);
    if (lamports < deployStep2MinRentLamports) {
      setDeployFundRentError(rentShortfallHintText(deployStep2MinRentLamports));
    } else {
      setDeployFundRentError(null);
    }
  }, [deployFundAmount, deployStep2MinRentLamports]);

  // Post-success fund-amount validation against on-chain Crossmint balance
  useEffect(() => {
    if (!deploySuccess) {
      setPostSuccessFundRentError(null);
      return;
    }
    const raw = postSuccessFundInput.trim();
    if (!raw) return;
    const addr = deployCrossmintAddrRef.current;
    if (!addr) return;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    const seq = ++postSuccessRentSeqRef.current;
    let cancelled = false;
    (async () => {
      try {
        const { requiredSendLamports } = await getRentTopUpLamports(
          solanaConnection,
          new PublicKey(addr)
        );
        if (cancelled || seq !== postSuccessRentSeqRef.current) return;
        const lamports = Math.round(n * LAMPORTS_PER_SOL);
        if (lamports < requiredSendLamports) {
          setPostSuccessFundRentError(rentShortfallHintText(requiredSendLamports));
        } else {
          setPostSuccessFundRentError(null);
        }
      } catch {
        if (!cancelled && seq === postSuccessRentSeqRef.current) {
          setPostSuccessFundRentError(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deploySuccess, postSuccessFundInput, solanaConnection]);

  // Auto-redirect to /workflows after funded-success
  useEffect(() => {
    if (!deploySuccess || !deploySuccessFunded || !deployAutoRedirectToWorkflows) return;
    setDeployFundedUiPhase('success');
    deployFundedNavTimerRef.current = setTimeout(() => {
      setDeployFundedUiPhase('redirect');
      deployFundedNavTimer2Ref.current = setTimeout(() => {
        router.push('/workflows');
        deployFundedNavTimerRef.current = null;
        deployFundedNavTimer2Ref.current = null;
      }, 400);
    }, 1500);
    return () => {
      if (deployFundedNavTimerRef.current) {
        clearTimeout(deployFundedNavTimerRef.current);
        deployFundedNavTimerRef.current = null;
      }
      if (deployFundedNavTimer2Ref.current) {
        clearTimeout(deployFundedNavTimer2Ref.current);
        deployFundedNavTimer2Ref.current = null;
      }
    };
  }, [deploySuccess, deploySuccessFunded, deployAutoRedirectToWorkflows, router]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleConfirmDeployPayment = useCallback(async () => {
    try {
      setIsDeploying(true);
      setDeployErrorMessage(null);
      deployAccountIdRef.current = null;
      deployCrossmintAddrRef.current = null;

      if (!canActivate || !accessToken || !walletAddress) {
        setDeployErrorMessage('Please sign in and complete invite verification first.');
        setIsDeploying(false);
        return;
      }

      const fundAmountSnapshot = parseFloat(String(deployFundAmount).trim());

      // Step 1: create empty canvas tied to this strategy name
      let canvasId: string;
      try {
        const newCanvas = await createCanvas(walletAddress, strategyName, [], []);
        canvasId = newCanvas.id!;
      } catch (e) {
        const error = e as { message?: string };
        setDeployErrorMessage(error?.message || 'Failed to create canvas.');
        setIsDeploying(false);
        return;
      }

      // Step 2: init wallet → create trading account
      let accountId: string | null = null;
      let crossmintAddress: string | null = null;
      try {
        const signature = await getBusinessSignature();
        const res = await initWallet(accessToken, walletAddress, signature, strategyName);
        if (res.id) {
          accountId = res.id;
          crossmintAddress = res.crossmint_wallet_address || null;
          deployCrossmintAddrRef.current = crossmintAddress;
          deployAccountIdRef.current = accountId;
        } else {
          setDeployErrorMessage(res.message || 'Failed to create trading account.');
          setIsDeploying(false);
          return;
        }
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('rejected') || message.includes('User rejected')) {
          setIsDeploying(false);
          return;
        }
        setDeployErrorMessage(`Init wallet failed: ${message}`);
        setIsDeploying(false);
        return;
      }

      // Step 3: create workflow template (empty for marketplace context)
      let workflowId: string | undefined;
      try {
        const workflowData = await createWorkflow(
          walletAddress,
          strategyName,
          [],
          [],
          undefined,
          canvasId
        );
        workflowId = workflowData.id;
      } catch (e: unknown) {
        const error = e as { code?: string; message?: string };
        if (error?.code === 'DUPLICATE_NAME' || error?.code === '23505') {
          setDeployErrorMessage(error?.message || `Workflow name "${strategyName}" already exists.`);
        } else {
          console.error('Failed to save workflow:', e);
          setDeployErrorMessage(error?.message || 'Failed to save workflow. Please try again.');
        }
        setIsDeploying(false);
        return;
      }

      // Link account ↔ workflow
      if (accountId && workflowId) {
        await supabase
          .from('accounts')
          .update({ current_workflow_id: workflowId })
          .eq('id', accountId);
      }
      await refreshAccounts();
      await refreshCanvases();

      // Step 4: optional SOL transfer to Crossmint wallet
      let transferSucceeded = false;
      let postDeployRentMinExtraLamports: number | null = null;
      if (crossmintAddress && Number.isFinite(fundAmountSnapshot) && fundAmountSnapshot > 0) {
        if (!wallet.connected || !wallet.publicKey) {
          showToast(
            'Step 2 deposit was skipped: Solana wallet is not connected. Connect your wallet and use Add Funds below.',
            'warning'
          );
        } else {
          try {
            const destPk = new PublicKey(crossmintAddress);
            const lamportsToSend = Math.round(fundAmountSnapshot * LAMPORTS_PER_SOL);
            const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, destPk);
            if (lamportsToSend < requiredSendLamports) {
              postDeployRentMinExtraLamports = requiredSendLamports;
            } else {
              const { blockhash, lastValidBlockHeight } =
                await solanaConnection.getLatestBlockhash();
              const tx = new Transaction({
                blockhash,
                lastValidBlockHeight,
                feePayer: wallet.publicKey,
              }).add(
                SystemProgram.transfer({
                  fromPubkey: wallet.publicKey,
                  toPubkey: destPk,
                  lamports: lamportsToSend,
                })
              );
              const sig = await signAndSendLegacyTransfer(wallet, solanaConnection, tx);
              await solanaConnection.confirmTransaction(
                { signature: sig, blockhash, lastValidBlockHeight },
                'confirmed'
              );
              transferSucceeded = true;
              setDeployFundAmount('');
            }
          } catch (err) {
            if (
              !(err instanceof Error) ||
              (!err.message.includes('rejected') && !err.message.includes('User rejected'))
            ) {
              showToast(`Transfer failed: ${formatSolTransferError(err)}`, 'error');
            }
          }
        }
      }

      // Compute funded balance from chain (authoritative)
      if (transferSucceeded && crossmintAddress) {
        const lamports = await solanaConnection.getBalance(new PublicKey(crossmintAddress));
        const balanceSol = lamports / LAMPORTS_PER_SOL;
        setDeploySuccessBalanceSol(balanceSol);
        setDeploySuccessUsdApprox(Math.round(balanceSol * SOL_USD_DISPLAY_APPROX));
        const funded = balanceSol > 0;
        setDeploySuccessFunded(funded);
        setDeployAutoRedirectToWorkflows(funded);
        setDeployFundedUiPhase('success');
      } else {
        setDeploySuccessBalanceSol(0);
        setDeploySuccessUsdApprox(0);
        setDeploySuccessFunded(false);
        setDeployAutoRedirectToWorkflows(false);
        setDeployFundedUiPhase('success');
      }
      setPostSuccessFundInput('');
      setDeploySuccess(true);
      setIsDeploying(false);
      if (postDeployRentMinExtraLamports !== null) {
        setPostSuccessFundRentError(rentShortfallHintText(postDeployRentMinExtraLamports));
      } else {
        setPostSuccessFundRentError(null);
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      console.error('Deploy failed:', err);
      setDeployErrorMessage(`Deploy failed: ${message}`);
      setIsDeploying(false);
    }
  }, [
    canActivate,
    accessToken,
    walletAddress,
    getBusinessSignature,
    refreshAccounts,
    refreshCanvases,
    deployFundAmount,
    strategyName,
    showToast,
    wallet,
    solanaConnection,
  ]);

  const handlePostSuccessAddFunds = useCallback(async () => {
    const amount = parseFloat(postSuccessFundInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Enter a valid amount.', 'warning');
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      showToast('Please connect your wallet first.', 'warning');
      return;
    }
    const crossmintAddress = deployCrossmintAddrRef.current;
    if (!crossmintAddress) {
      showToast('No Crossmint wallet linked.', 'warning');
      return;
    }
    const lamportsToSend = Math.round(amount * LAMPORTS_PER_SOL);
    const destPk = new PublicKey(crossmintAddress);
    const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, destPk);
    if (lamportsToSend < requiredSendLamports) {
      setPostSuccessFundRentError(rentShortfallHintText(requiredSendLamports));
      return;
    }
    setPostSuccessFundRentError(null);
    setPostSuccessFunding(true);
    try {
      const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash();
      const tx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: wallet.publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: destPk,
          lamports: lamportsToSend,
        })
      );
      const signature = await signAndSendLegacyTransfer(wallet, solanaConnection, tx);
      await solanaConnection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      const lamports = await solanaConnection.getBalance(new PublicKey(crossmintAddress));
      const balanceSol = lamports / LAMPORTS_PER_SOL;
      setDeploySuccessBalanceSol(balanceSol);
      setDeploySuccessUsdApprox(Math.round(balanceSol * SOL_USD_DISPLAY_APPROX));
      setDeploySuccessFunded(balanceSol > 0);
      setPostSuccessFundInput('');
      showToast('Funds deposited.', 'success');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (!message.includes('rejected') && !message.includes('User rejected')) {
        showToast(`Transfer failed: ${formatSolTransferError(err)}`, 'error');
      }
    } finally {
      setPostSuccessFunding(false);
    }
  }, [postSuccessFundInput, wallet, showToast, solanaConnection]);

  const handleActivateStrategyAccount = useCallback(async () => {
    clearDeployFundedAutoNavTimers();
    const accountId = deployAccountIdRef.current;
    if (!accountId || !walletAddress) {
      showToast('Missing trading account. Try activating again.', 'warning');
      return;
    }
    setPostSuccessActivating(true);
    try {
      const { data, error } = await supabase
        .from('accounts')
        .update({ status: 'active' })
        .eq('id', accountId)
        .eq('owner_wallet_address', walletAddress)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        showToast('Could not activate strategy (not found or not your account).', 'error');
        return;
      }

      await refreshAccounts();
      showToast('Strategy activated.', 'success');
      setDeploySuccess(false);
      setDeploySuccessFunded(false);
      setDeploySuccessBalanceSol(0);
      setDeploySuccessUsdApprox(0);
      setPostSuccessFundInput('');
      onActivated?.();
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      console.error('Activate strategy failed:', err);
      showToast(`Could not activate: ${message}`, 'error');
    } finally {
      setPostSuccessActivating(false);
    }
  }, [walletAddress, refreshAccounts, showToast, clearDeployFundedAutoNavTimers, onActivated]);

  const isOutcomeMode = deploySuccess || !!deployErrorMessage || isDeploying;

  return (
    <div
      className={styles.deployOverlay}
      onClick={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        className={`${styles.deployModal} ${isOutcomeMode ? styles.deployModalOutcome : ''}`}
      >
        {deployErrorMessage ? (
          /* ── Failed! ── */
          <>
            <div className={styles.deployResultHeader}>
              <div className={styles.deployResultTitleFail}>Failed!</div>
              <p className={styles.deployResultSub}>
                We couldn&apos;t activate your strategy.
              </p>
            </div>
            <div className={styles.deployErrorReasonBlock}>
              <div className={styles.deployErrorReasonLabel}>Reason:</div>
              <div className={styles.deployErrorReasonText}>{deployErrorMessage}</div>
            </div>
            <div className={styles.deployActions}>
              <Secondary
                type="button"
                className={styles.deployActionGrow}
                fullWidth
                onClick={() =>
                  window.open('https://t.me/pintoolfam', '_blank', 'noopener,noreferrer')
                }
              >
                Support
              </Secondary>
              <Primary
                type="button"
                className={styles.deployActionGrow}
                fullWidth
                onClick={() => {
                  setDeployErrorMessage(null);
                  onClose();
                }}
              >
                Fix Now
              </Primary>
            </div>
          </>
        ) : isDeploying ? (
          /* ── Active Ready! (deploying) ── */
          <div
            className={styles.deployDeployingWrap}
            aria-busy="true"
            aria-live="polite"
          >
            <div className={styles.deployDeployingHead}>
              <div className={styles.deployResultTitleOk}>Active Ready!</div>
              <div className={styles.deployDeployingStatusRow}>
                <img
                  src="/loading.svg"
                  alt=""
                  className={styles.deployDeployingSpinner}
                  aria-hidden
                />
                <p className={styles.deployDeployingStatusText}>
                  Strategy is being established...
                </p>
              </div>
            </div>
            <div className={styles.deployDeployingNote} role="status">
              <span className={styles.deployDeployingNoteStar} aria-hidden>
                *
              </span>
              <span className={styles.deployDeployingNoteText}>Do not close this window</span>
            </div>
          </div>
        ) : deploySuccess ? (
          deploySuccessFunded ? (
            deployFundedUiPhase === 'redirect' ? (
              /* Redirecting to portfolio */
              <div className={styles.deployPortfolioRedirectWrap}>
                <div className={styles.deployPortfolioRedirectHead}>
                  <div className={styles.deployPortfolioRedirectTitle}>Active!</div>
                  <div className={styles.deployPortfolioRedirectStatusRow}>
                    <img
                      src="/loading.svg"
                      alt=""
                      className={styles.deployPortfolioRedirectSpinner}
                      aria-hidden
                    />
                    <p className={styles.deployPortfolioRedirectStatusText}>
                      Redirecting to your portfolio...
                    </p>
                  </div>
                </div>
                <div className={styles.deployPortfolioRedirectActions}>
                  <Secondary
                    type="button"
                    className={styles.deployActionGrow}
                    fullWidth
                    onClick={() => {
                      clearDeployFundedAutoNavTimers();
                      router.push('/workflows');
                    }}
                  >
                    Portfolio
                  </Secondary>
                </div>
              </div>
            ) : (
              /* Successful + funded */
              <>
                <div className={styles.deployResultHeader}>
                  <div className={styles.deployResultTitleOk}>Successful!</div>
                  <p className={styles.deployResultSub}>
                    Your strategy is ready, let&apos;s add funds and activate strategy.
                  </p>
                </div>
                <div className={styles.deployOutcomeBalanceRow}>
                  <span className={styles.deployOutcomeBalanceLabel}>Balance:</span>
                  <span className={styles.deployOutcomeBalanceSol}>
                    {deploySuccessBalanceSol.toFixed(1)}
                  </span>
                  <span className={styles.deployOutcomeBalanceUnit}>SOL</span>
                  <span className={styles.deployOutcomeApprox}>
                    <span aria-hidden>≈</span>
                    <span>{deploySuccessUsdApprox}</span>
                    <span>USD</span>
                  </span>
                </div>
                <div className={styles.deploySuccessTopActions}>
                  <Secondary
                    type="button"
                    className={styles.deployActionGrow}
                    fullWidth
                    onClick={() => {
                      clearDeployFundedAutoNavTimers();
                      router.push('/workflows');
                    }}
                  >
                    Portfolio
                  </Secondary>
                  <Primary
                    type="button"
                    className={styles.deployActivatePrimary169}
                    fullWidth
                    disabled={postSuccessActivating}
                    onClick={handleActivateStrategyAccount}
                  >
                    {postSuccessActivating ? 'Activating…' : 'Activate Strategy'}
                  </Primary>
                </div>
              </>
            )
          ) : (
            /* Successful but not funded yet — Add Funds + Activate */
            <>
              <div className={styles.deployResultHeader}>
                <div className={styles.deployResultTitleOk}>Successful!</div>
                <p className={styles.deployResultSub}>
                  Your strategy is ready, let&apos;s add funds and activate strategy.
                </p>
              </div>
              <div className={styles.deployOutcomeBalanceRow}>
                <span className={styles.deployOutcomeBalanceLabel}>Balance:</span>
                <span className={styles.deployOutcomeBalanceSol}>
                  {deploySuccessBalanceSol.toFixed(1)}
                </span>
                <span className={styles.deployOutcomeBalanceUnit}>SOL</span>
                <span className={styles.deployOutcomeApprox}>
                  <span aria-hidden>≈</span>
                  <span>{deploySuccessUsdApprox}</span>
                  <span>USD</span>
                </span>
              </div>
              <div className={styles.deploySuccessTopActions}>
                <Secondary
                  type="button"
                  className={styles.deployActionGrow}
                  fullWidth
                  onClick={() => router.push('/workflows')}
                >
                  Portfolio
                </Secondary>
                <Secondary
                  type="button"
                  className={styles.deployActionGrow}
                  fullWidth
                  disabled={postSuccessFunding || postSuccessActivating}
                  onClick={handlePostSuccessAddFunds}
                >
                  {postSuccessFunding ? 'Sending…' : 'Add Funds'}
                </Secondary>
              </div>
              <div className={styles.deployPostSuccessFundBlock}>
                <div className={styles.deployFundFieldStack}>
                  <FormInput
                    fullWidth
                    ref={postSuccessFundInputRef}
                    error={!!postSuccessFundRentError}
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="0.1"
                    value={postSuccessFundInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPostSuccessFundInput(v);
                      if (!v.trim()) {
                        setPostSuccessFundRentError(null);
                      }
                    }}
                    leadingSlot={
                      <img src="/solana.svg" alt="SOL" className={styles.deploySolIcon} />
                    }
                  />
                  {postSuccessFundRentError && (
                    <div className={styles.deployRentHint} role="alert">
                      <span className={styles.deployRentHintStar} aria-hidden>
                        *
                      </span>
                      <span className={styles.deployRentHintText}>
                        {postSuccessFundRentError}
                      </span>
                    </div>
                  )}
                </div>
                <div className={styles.deployPctRow}>
                  {(
                    [
                      { label: '10%', value: '0.1' },
                      { label: '25%', value: '0.25' },
                      { label: '50%', value: '0.5' },
                      { label: '100%', value: '1' },
                    ] as const
                  ).map(({ label, value }) => (
                    <Secondary
                      key={label}
                      type="button"
                      className={styles.deployPctSecondary}
                      onClick={() => setPostSuccessFundInput(value)}
                    >
                      {label}
                    </Secondary>
                  ))}
                </div>
              </div>
              <div className={styles.deployActivateOnlyRow}>
                <Primary
                  type="button"
                  className={styles.deployActionGrow}
                  fullWidth
                  disabled={postSuccessActivating || postSuccessFunding}
                  onClick={handleActivateStrategyAccount}
                >
                  {postSuccessActivating ? 'Activating…' : 'Activate Strategy'}
                </Primary>
              </div>
            </>
          )
        ) : (
          /* ── Deploy Ready! (Step 2 — name fixed by marketplace) ── */
          <>
            <div className={styles.deployModalTitle}>Deploy Ready!</div>

            <div className={styles.deployNameField}>
              <span className={styles.deployNameReadonly}>{strategyName}</span>
            </div>

            <div className={styles.deployStep2Section}>
              <div className={styles.deployFundFieldStack}>
                <FormInput
                  fullWidth
                  error={!!deployFundRentError}
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.1"
                  value={deployFundAmount}
                  onChange={(e) => setDeployFundAmount(e.target.value)}
                  leadingSlot={
                    <img src="/solana.svg" alt="SOL" className={styles.deploySolIcon} />
                  }
                />
                {deployFundRentError && (
                  <div className={styles.deployRentHint} role="alert">
                    <span className={styles.deployRentHintStar} aria-hidden>
                      *
                    </span>
                    <span className={styles.deployRentHintText}>{deployFundRentError}</span>
                  </div>
                )}
              </div>
              <div className={styles.deployFeeRow}>
                <span className={styles.deployFeeLabel}>Deploy Fee</span>
                <div className={styles.deployFeeValues}>
                  <div className={styles.deployFeeStrike}>
                    <span>0.5</span>
                    <span>SOL</span>
                  </div>
                  <div className={styles.deployFeeActual}>
                    <span>0.0</span>
                    <span>SOL</span>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.deployHelperSection}>
              <div className={styles.deployWarningBox}>
                <div className={styles.deployWarningDot} />
                <div className={styles.deployWarningText}>
                  This strategy may execute frequently once activated.
                </div>
              </div>
              <div className={styles.deployNoteRow}>
                <div className={styles.deployNoteAsteriskCol}>
                  <div className={styles.deployNoteAsterisk}>*</div>
                  <div className={styles.deployNoteAsteriskInvisible}>*</div>
                </div>
                <div className={styles.deployNoteText}>
                  Deploy and Activate are two steps, funds can be added now or later.
                </div>
              </div>
            </div>

            <div className={styles.deployActions}>
              <Secondary
                className={styles.deployActionGrow}
                fullWidth
                onClick={onClose}
              >
                Cancel
              </Secondary>
              <Primary
                className={styles.deployActionGrow}
                fullWidth
                onClick={handleConfirmDeployPayment}
              >
                Deploy
              </Primary>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
