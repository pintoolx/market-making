'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import styles from './not-found.module.css';

export default function NotFound() {
  const router = useRouter();

  // Auto-redirect to home after 5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      router.push('/');
    }, 5000);

    return () => clearTimeout(timer);
  }, [router]);

  const handleGoHome = () => {
    router.push('/');
  };

  const handleTryAgain = () => {
    router.refresh();
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
        <div className={styles.icon}>🔍</div>
        <h1 className={styles.title}>Page Not Found</h1>
        <p className={styles.message}>
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <p className={styles.redirect}>
          You&apos;ll be redirected to the home page in a few seconds...
        </p>

        <div className={styles.actions}>
          <button onClick={handleTryAgain} className={`${styles.button} ${styles.primary}`}>
            Try Again
          </button>
          <button onClick={handleGoHome} className={`${styles.button} ${styles.secondary}`}>
            Go to Home
          </button>
          <button onClick={handleGoBack} className={`${styles.button} ${styles.secondary}`}>
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
}