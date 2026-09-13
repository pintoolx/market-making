'use client';

import React from 'react';
import styles from './global-error.module.css';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const handleGoHome = () => {
    window.location.href = '/';
  };

  return (
    <html>
      <body>
        <div className={styles.container}>
          <div className={styles.content}>
            <h1 className={styles.title}>PinTool couldn&apos;t load this page</h1>
            <p className={styles.message}>Your wallet and funds are unaffected. Try loading the page again or return home.</p>

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
                Go home
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
