'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import FormInput from './FormInput';
import styles from './ArchiveStrategyModal.module.css';

export type ArchiveStrategyModalProps = {
  open: boolean;
  strategyTitle: string;
  onClose: () => void;
  onConfirmArchive: () => void;
};

const BULLETS = [
  'My strategy will be unpublished',
  'Everyone will lose access to this strategy',
  'All unwithdrawn balances in this strategy will not be withdrawn',
] as const;

export default function ArchiveStrategyModal({
  open,
  strategyTitle,
  onClose,
  onConfirmArchive,
}: ArchiveStrategyModalProps) {
  const titleId = useId();
  const inputId = useId();
  const [confirmText, setConfirmText] = useState('');
  const [mounted, setMounted] = useState(false);

  const expected = strategyTitle.trim();
  const canDelete = expected.length > 0 && confirmText.trim() === expected;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) setConfirmText('');
  }, [open, strategyTitle]);

  const handleOverlayPointerDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleDelete = useCallback(() => {
    if (!canDelete) return;
    onConfirmArchive();
    onClose();
  }, [canDelete, onConfirmArchive, onClose]);

  if (!mounted || typeof document === 'undefined' || !open) return null;

  return createPortal(
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={handleOverlayPointerDown}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            Archive strategy
          </h2>
          <p className={styles.subtitle}>
            Archiving this strategy will immediately remove it from your account.
          </p>
        </div>

        <div className={styles.warningBox}>
          <p className={styles.warningLead}>I understand that:</p>
          <div className={styles.bulletList}>
            {BULLETS.map(text => (
              <div key={text} className={styles.bulletRow}>
                <span className={styles.bulletDot} aria-hidden />
                <p className={styles.bulletText}>{text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.confirmBlock}>
          <p className={styles.confirmLabel}>
            Confirm by typing{' '}
            <span className={styles.confirmHighlight}>{strategyTitle || 'strategy name'}</span>{' '}
            below.
          </p>
          <FormInput
            id={inputId}
            fullWidth
            type="text"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={strategyTitle || 'Strategy name'}
            autoComplete="off"
            aria-label="Type strategy name to confirm archive"
          />
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.deleteBtn} ${canDelete ? styles.deleteBtnEnabled : ''}`}
            disabled={!canDelete}
            onClick={handleDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
