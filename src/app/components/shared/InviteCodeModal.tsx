'use client';

import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { redeemReferralCode } from '../../lib/pintoolApi';
import { INVITE_FRIENDS_URL, setInvitedByCode } from '../../lib/referralStorage';
import FormInput from './FormInput';
import styles from './InviteCodeModal.module.css';

export default function InviteCodeModal() {
  const {
    isAuthenticated,
    hasRedeemedReferral,
    walletAddress,
    accessToken,
    setReferralRedeemed,
  } = useAuth();

  const [code, setCode] = useState('');
  const [submitFailed, setSubmitFailed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (hasRedeemedReferral) return null;

  const canSubmit =
    isAuthenticated && !!accessToken && code.trim().length > 0 && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated || !canSubmit || !walletAddress || !accessToken) return;

    setSubmitFailed(false);
    setIsSubmitting(true);

    try {
      await redeemReferralCode(accessToken, code.trim(), { source: 'onboarding' });
      setInvitedByCode(walletAddress, code.trim());
      setReferralRedeemed();
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) {
        setSubmitFailed(false);
      } else {
        setSubmitFailed(true);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <form className={styles.modal} onSubmit={handleSubmit}>
        <div className={styles.title}>Enter Invite Code</div>

        <FormInput
          fullWidth
          error={submitFailed}
          type="text"
          placeholder="Enter"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (submitFailed) setSubmitFailed(false);
          }}
          autoFocus={isAuthenticated}
        />

        <div className={styles.fieldFooter}>
          {submitFailed && (
            <div className={styles.errorBanner} role="alert">
              <span className={styles.errorDot} aria-hidden />
              <span className={styles.errorBannerText}>Please check and try again.</span>
            </div>
          )}
          <div className={styles.helperRow}>
            <span className={styles.helperText}>
              <span className={styles.asterisk}>*</span>
              No invitation code?
            </span>
            <a
              href={INVITE_FRIENDS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.claimLink}
            >
              Claim!
            </a>
          </div>
        </div>

        <button
          type="submit"
          className={`${styles.startButton} ${canSubmit && !submitFailed ? styles.active : ''}`}
          disabled={!canSubmit || submitFailed}
        >
          {isSubmitting ? 'Verifying...' : 'Start'}
        </button>
      </form>
    </div>
  );
}
