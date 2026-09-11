'use client';

import React from 'react';
import Navigation from './Navigation';
import LoadingTransition from './LoadingTransition';
import ErrorBoundary from './ErrorBoundary';
import { useNavigation } from '../../contexts/NavigationContext';
import styles from './Layout.module.css';

interface LayoutProps {
  children: React.ReactNode;
  showNavigation?: boolean;
  pageType: 'entry' | 'workflows';
}

export default function Layout({ 
  children, 
  showNavigation = true, 
  pageType 
}: LayoutProps) {
  const { navigationState } = useNavigation();

  return (
    <div className={styles.layoutWrapper} data-page-type={pageType}>
      {showNavigation && (
        <Navigation 
          currentPage={pageType} 
          showBackToHome={pageType !== 'entry'} 
        />
      )}
      
      <main className={`${styles.mainContent} ${!showNavigation ? styles.fullHeight : ''}`}>
        <div className={styles.contentWrapper}>
          <ErrorBoundary pageType={pageType}>
            {children}
          </ErrorBoundary>
        </div>
      </main>

      <LoadingTransition 
        isVisible={navigationState.isNavigating} 
        message="Navigating..."
      />
    </div>
  );
}