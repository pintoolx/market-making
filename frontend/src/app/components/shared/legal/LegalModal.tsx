'use client';

import { useEffect, useRef } from 'react';
import styles from './LegalModal.module.css';

// Opened from the footer so a half-filled Provider draft or Maker form is not lost by navigating away.
export default function LegalModal({ title, updated, open, onClose, children }: { title: string; updated: string; open: boolean; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = `legal-${title.toLowerCase().replace(/\s+/g, '-')}`;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
      <div className={styles.panel}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        <h2 id={titleId}>{title}</h2>
        <p className={styles.updated}>Last updated: {updated}</p>
        <div className={styles.body}>{children}</div>
      </div>
    </dialog>
  );
}
