'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useNavigation } from '../../contexts/NavigationContext';
import styles from './Navigation.module.css';

interface NavigationProps {
  currentPage: 'entry' | 'workflows';
  showBackToHome?: boolean;
}

export default function Navigation({ currentPage, showBackToHome = true }: NavigationProps) {
  const pathname = usePathname();
  const { navigateTo, goBack, canGoBack } = useNavigation();

  const getPageTitle = () => {
    switch (currentPage) {
      case 'workflows':
        return 'Workflows';
      default:
        return 'PinTool';
    }
  };

  const isActive = (path: string) => {
    if (path === '/' && pathname === '/') return true;
    if (path !== '/' && pathname.startsWith(path)) return true;
    return false;
  };

  return (
    <nav className={styles.navigation} role="navigation" aria-label="Main navigation">
      <div className={styles.navContent}>
        {/* Left side - Logo/Title and current page indicator */}
        <div className={styles.leftSection}>
          <Link 
            href="/" 
            className={styles.logo}
            aria-label="PinTool home page"
          >
            <Image
              src="/pintoolLogo.svg"
              alt="PinTool Logo"
              width={190}
              height={40}
              priority
            />
          </Link>
          
          {currentPage !== 'entry' && (
            <>
              <span className={styles.separator} aria-hidden="true">/</span>
              <span className={styles.currentPage} aria-current="page">{getPageTitle()}</span>
            </>
          )}
        </div>

        {/* Right side - Navigation links */}
        <div className={styles.rightSection} role="menubar">
          {canGoBack && currentPage !== 'entry' && (
            <button 
              onClick={goBack}
              className={`${styles.navLink} ${styles.backButton}`}
              title="Go back to previous page"
              aria-label="Go back to previous page"
              role="menuitem"
            >
              <span className={styles.navIcon} aria-hidden="true">←</span>
              <span>Back</span>
            </button>
          )}
          
          {currentPage !== 'entry' && showBackToHome && (
            <button 
              onClick={() => navigateTo('/')}
              className={`${styles.navLink} ${isActive('/') ? styles.active : ''}`}
              aria-label="Go to home page"
              aria-current={isActive('/') ? 'page' : undefined}
              role="menuitem"
            >
              <span className={styles.navIcon} aria-hidden="true">🏠</span>
              <span>Home</span>
            </button>
          )}
          
          {currentPage !== 'workflows' && (
            <button 
              onClick={() => navigateTo('/workflows')}
              className={`${styles.navLink} ${isActive('/workflows') ? styles.active : ''}`}
              aria-label="Go to Workflows - Browse strategies"
              aria-current={isActive('/workflows') ? 'page' : undefined}
              role="menuitem"
            >
              <span className={styles.navIcon} aria-hidden="true">💰</span>
              <span>Workflows</span>
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}