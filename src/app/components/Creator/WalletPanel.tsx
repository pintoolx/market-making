'use client';

import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { initWallet, deleteWallet, exportWallet } from '../../lib/pintoolApi';
import { useToast } from '../shared/Toast';
import styles from './WalletPanel.module.css';

export default function WalletPanel() {
  const { isAuthenticated, accessToken, walletAddress, accounts, getBusinessSignature, refreshAccounts } = useAuth();
  const account = accounts[0] || null;
  const { showToast } = useToast();

  // UI state
  const [isCreating, setIsCreating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [exportedKey, setExportedKey] = useState<string | null>(null);

  // 未登入時不顯示
  if (!isAuthenticated || !accessToken) {
    return null;
  }

  // ─── 流程 B: Create Trading Account ────────────────────

  const handleCreateWallet = async () => {
    if (isCreating || !accountName.trim()) return;
    setIsCreating(true);
    try {
      const signature = await getBusinessSignature();
      const res = await initWallet(accessToken, walletAddress!, signature, accountName.trim());
      if (res.id) {
        await refreshAccounts();
        showToast('Trading account created!', 'success');
        setShowCreateForm(false);
        setAccountName('');
      } else {
        showToast(res.message || 'Created but no wallet ID returned.', 'warning');
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) {
        return;
      }
      showToast(`Create failed: ${message}`, 'error');
    } finally {
      setIsCreating(false);
    }
  };

  // ─── 流程 C: Export Wallet ─────────────────────────────

  const handleExportWallet = async () => {
    if (isExporting || !account?.id) return;
    setIsExporting(true);
    try {
      const signature = await getBusinessSignature();
      const res = await exportWallet(accessToken, account.id, walletAddress!, signature);
      if (res.privateKey) {
        setExportedKey(res.privateKey);
        showToast('Private key exported. Copy it now.', 'warning', 10000);
      } else {
        showToast('Export completed but no key returned.', 'warning');
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) return;
      showToast(`Export failed: ${message}`, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  // ─── 流程 D: Delete Wallet ─────────────────────────────

  const handleDeleteWallet = async () => {
    if (isDeleting || !account?.id) return;
    setIsDeleting(true);
    try {
      const signature = await getBusinessSignature();
      await deleteWallet(accessToken, account.id, walletAddress!, signature);
      await refreshAccounts();
      showToast('Account deleted successfully.', 'success');
      setShowConfirmDelete(false);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) {
        setShowConfirmDelete(false);
        return;
      }
      showToast(`Delete failed: ${message}`, 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyKey = () => {
    if (exportedKey) {
      navigator.clipboard.writeText(exportedKey);
      showToast('Private key copied to clipboard.', 'success', 3000);
    }
  };

  return (
    <div className={styles.walletPanel}>
      <div className={styles.walletInfo}>
        <div className={styles.walletIcon}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
            <path d="M16 14h2" />
          </svg>
        </div>
        <span className={styles.walletAddress}>
          {account?.crossmint_wallet_address
            ? `${account.crossmint_wallet_address.slice(0, 6)}...${account.crossmint_wallet_address.slice(-4)}`
            : walletAddress
              ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
              : 'Unknown'}
        </span>
      </div>

      <div className={styles.walletActions}>
        {/* 沒有 account 時顯示 Create 按鈕 */}
        {!account ? (
          <>
            {!showCreateForm ? (
              <button
                className={`${styles.actionButton} ${styles.createButton}`}
                onClick={() => setShowCreateForm(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create Trading Account
              </button>
            ) : (
              <div className={styles.createForm}>
                <input
                  className={styles.nameInput}
                  type="text"
                  placeholder="Account name"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateWallet()}
                  autoFocus
                />
                <button
                  className={`${styles.actionButton} ${styles.createButton}`}
                  onClick={handleCreateWallet}
                  disabled={isCreating || !accountName.trim()}
                >
                  {isCreating ? '...' : 'Create'}
                </button>
                <button
                  className={styles.actionButton}
                  onClick={() => { setShowCreateForm(false); setAccountName(''); }}
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {/* 有 wallet 時顯示 Export / Delete */}
            <button
              className={styles.actionButton}
              onClick={handleExportWallet}
              disabled={isExporting}
              title="Export private key"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {isExporting ? 'Exporting...' : 'Export'}
            </button>

            {!showConfirmDelete ? (
              <button
                className={`${styles.actionButton} ${styles.deleteButton}`}
                onClick={() => setShowConfirmDelete(true)}
                title="Delete account"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete
              </button>
            ) : (
              <div className={styles.confirmGroup}>
                <span className={styles.confirmText}>Confirm?</span>
                <button
                  className={`${styles.actionButton} ${styles.confirmYes}`}
                  onClick={handleDeleteWallet}
                  disabled={isDeleting}
                >
                  {isDeleting ? '...' : 'Yes'}
                </button>
                <button
                  className={styles.actionButton}
                  onClick={() => setShowConfirmDelete(false)}
                >
                  No
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Exported key modal */}
      {exportedKey && (
        <div className={styles.exportOverlay}>
          <div className={styles.exportModal}>
            <div className={styles.exportTitle}>Private Key</div>
            <div className={styles.exportWarning}>
              Store this key securely. It will not be shown again.
            </div>
            <div className={styles.exportKey}>
              {exportedKey}
            </div>
            <div className={styles.exportActions}>
              <button className={styles.copyButton} onClick={handleCopyKey}>
                Copy
              </button>
              <button className={styles.closeButton} onClick={() => setExportedKey(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
