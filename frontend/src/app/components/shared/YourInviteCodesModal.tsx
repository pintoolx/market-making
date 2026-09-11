'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import styles from './YourInviteCodesModal.module.css';

export type InviteCodeItem = {
  code: string;
  used: boolean;
};

type YourInviteCodesModalProps = {
  open: boolean;
  onClose: () => void;
  codes: InviteCodeItem[];
};

function CheckIcon() {
  return (
    <svg className={styles.checkIcon} width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 8L6.5 11L12.5 4.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function YourInviteCodesModal({ open, onClose, codes }: YourInviteCodesModalProps) {
  const [mounted, setMounted] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  useEffect(() => {
    if (!open) setCopiedCode(null);
  }, [open]);

  useEffect(() => {
    if (!copiedCode) return;
    const t = window.setTimeout(() => setCopiedCode(null), 2000);
    return () => window.clearTimeout(t);
  }, [copiedCode]);

  const copyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedCode(code);
      } catch {
        /* ignore */
      }
    }
  }, []);

  if (!mounted || typeof document === 'undefined' || !open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="your-invite-codes-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.headerBlock}>
          <div className={styles.headerRow}>
            <h2 id="your-invite-codes-title" className={styles.title}>
              Your Invite Codes
            </h2>
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <X size={16} strokeWidth={2.25} />
            </button>
          </div>
          <p className={styles.subtitle}>Share your code with friends to invite them.</p>
        </div>

        <div className={styles.codeList}>
          {codes.length === 0 ? (
            <p className={styles.emptyNote}>No invite codes yet.</p>
          ) : (
            codes.map((item) => {
              if (item.used) {
                return (
                  <div key={item.code} className={styles.codeRowUsed}>
                    <span>{item.code}</span>
                    <span className={styles.usedSuffix}>(Used)</span>
                  </div>
                );
              }
              const isCopied = copiedCode === item.code;
              return (
                <button
                  key={item.code}
                  type="button"
                  className={`${styles.codeBtn} ${isCopied ? styles.codeBtnCopied : ''}`}
                  onClick={() => copyCode(item.code)}
                  aria-label={isCopied ? 'Copied' : `Copy invite code ${item.code}`}
                >
                  {isCopied ? (
                    <>
                      <CheckIcon />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <span>{item.code}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
