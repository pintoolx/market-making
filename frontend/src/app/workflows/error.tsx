'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import styles from '../error.module.css';

interface WorkflowsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function WorkflowsError({ error, reset }: WorkflowsErrorProps) {
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
        <div className={styles.icon}>🏪💥</div>
        <h1 className={styles.title}>Workflows Error</h1>
        <p className={styles.message}>
          There was an error loading the Workflows page. This might be due to a problem 
          loading strategies from the marketplace.
        </p>

        {process.env.NODE_ENV === 'development' && error && (
          <details className={styles.errorDetails}>
            <summary>Error Details (Development)</summary>
            <pre className={styles.errorStack}>
              {error.message}
              {error.stack}
            </pre>
          </details>
        )}

        <div className={styles.actions}>
          <button onClick={reset} className={`${styles.button} ${styles.primary}`}>
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