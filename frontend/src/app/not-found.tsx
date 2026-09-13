'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import styles from './not-found.module.css';

export default function NotFound() {
  const router = useRouter();

  const handleGoHome = () => {
    router.push('/');
  };

  const handleGoBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }

    router.push('/');
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <h1 className={styles.title}>We couldn&apos;t find that page</h1>
        <p className={styles.message}>Check the address, go back to the previous page or return to PinTool.</p>

        <div className={styles.actions}>
          <button onClick={handleGoHome} className={`${styles.button} ${styles.secondary}`}>
            Go home
          </button>
          <button onClick={handleGoBack} className={`${styles.button} ${styles.secondary}`}>
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
