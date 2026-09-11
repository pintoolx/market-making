'use client';

import React, { useEffect, useRef, useState } from 'react';
import styles from './PrioritySelect.module.css';

type Priority = 'Low' | 'Medium' | 'High';

interface PrioritySelectProps {
  value: Priority;
  onChange: (value: Priority) => void;
  getFeeLabel: (p: Priority) => string;
}

export default function PrioritySelect({ value, onChange, getFeeLabel }: PrioritySelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const priorities: Priority[] = ['Low', 'Medium', 'High'];

  return (
    <div className={styles.prioritySelect} ref={ref}>
      <div
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen(!open)}
      >
        <div className={styles.row}>
          <div className={styles.left}>{value}</div>
          <div className={styles.arrow}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M6 9L12 15L18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
      </div>

      {open && (
        <div className={styles.dropdown}>
          {priorities.map((p) => (
            <div
              key={p}
              className={`${styles.option} ${p === value ? styles.selected : ''}`}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <div className={styles.row}>
                <div className={styles.left}>{p}</div>
                <div className={styles.right}>
                  <div className={styles.primary}>{getFeeLabel(p)}</div>
                  <div className={styles.secondary}>Estimated Network Fee</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


