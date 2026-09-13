'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './builder.module.css';

export default function BuilderDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog className={styles.dialog} ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.dialogHeading}><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close dialog">Close ×</button></div>
    {children}
  </dialog>;
}
