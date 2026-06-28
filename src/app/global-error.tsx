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

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <html>
      <body>
        <div className={styles.container}>
          <div className={styles.content}>
            <div className={styles.icon}>💥</div>
            <h1 className={styles.title}>Application Error</h1>
            <p className={styles.message}>
              A critical error occurred that prevented the application from loading properly.
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
              <button onClick={handleReload} className={`${styles.button} ${styles.secondary}`}>
                Reload Page
              </button>
              <button onClick={handleGoHome} className={`${styles.button} ${styles.secondary}`}>
                Go to Home
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}