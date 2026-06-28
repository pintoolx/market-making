'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  pageType?: 'entry' | 'workflows';
}

class ErrorBoundaryClass extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback
          error={this.state.error}
          pageType={this.props.pageType}
          onRetry={() => this.setState({ hasError: false })}
        />
      );
    }

    return this.props.children;
  }
}

interface ErrorFallbackProps {
  error?: Error;
  pageType?: 'entry' | 'workflows';
  onRetry: () => void;
}

function ErrorFallback({ error, pageType, onRetry }: ErrorFallbackProps) {
  const goBackOrHome = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }

    window.location.href = '/';
  };

  const getErrorMessage = () => {
    switch (pageType) {
      case 'workflows':
        return 'There was an error loading the Workflows page. This might be due to a problem loading the strategy marketplace.';
      default:
        return 'Something went wrong while loading this page.';
    }
  };

  const getRecoveryActions = () => {
    switch (pageType) {
      case 'workflows':
        return [
          { label: 'Try Again', action: onRetry },
          { label: 'Go to Home', action: () => window.location.href = '/' },
          { label: 'Go Back', action: goBackOrHome },
        ];
      default:
        return [
          { label: 'Try Again', action: onRetry },
          { label: 'Go to Home', action: () => window.location.href = '/' },
        ];
    }
  };

  return (
    <div className={styles.errorContainer}>
      <div className={styles.errorContent}>
        <div className={styles.errorIcon}>⚠️</div>
        <h2 className={styles.errorTitle}>Oops! Something went wrong</h2>
        <p className={styles.errorMessage}>{getErrorMessage()}</p>
        
        {error && process.env.NODE_ENV === 'development' && (
          <details className={styles.errorDetails}>
            <summary>Error Details (Development)</summary>
            <pre className={styles.errorStack}>
              {error.message}
              {error.stack}
            </pre>
          </details>
        )}

        <div className={styles.errorActions}>
          {getRecoveryActions().map((action, index) => (
            <button
              key={index}
              onClick={action.action}
              className={`${styles.errorButton} ${index === 0 ? styles.primary : styles.secondary}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Wrapper component to use hooks
export default function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorBoundaryClass {...props} />;
}