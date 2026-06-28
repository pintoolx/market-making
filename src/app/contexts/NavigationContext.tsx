'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

interface NavigationState {
  isNavigating: boolean;
  previousPath: string | null;
  navigationHistory: string[];
  hasError: boolean;
  errorCount: number;
}

interface NavigationContextType {
  navigationState: NavigationState;
  navigateTo: (path: string, preserveState?: boolean) => void;
  goBack: () => void;
  canGoBack: boolean;
  clearError: () => void;
  reportError: () => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  
  const [navigationState, setNavigationState] = useState<NavigationState>({
    isNavigating: false,
    previousPath: null,
    navigationHistory: [pathname],
    hasError: false,
    errorCount: 0,
  });

  // Update navigation history when pathname changes
  useEffect(() => {
    setNavigationState(prev => {
      const newHistory = [...prev.navigationHistory];
      if (newHistory[newHistory.length - 1] !== pathname) {
        newHistory.push(pathname);
        // Keep only last 10 entries to prevent memory issues
        if (newHistory.length > 10) {
          newHistory.shift();
        }
      }
      
      return {
        ...prev,
        previousPath: prev.navigationHistory[prev.navigationHistory.length - 1] || null,
        navigationHistory: newHistory,
        isNavigating: false, // Reset navigation state when route changes
      };
    });
  }, [pathname]);

  const navigateTo = useCallback((path: string) => {
    setNavigationState(prev => ({
      ...prev,
      isNavigating: true,
      hasError: false, // Clear error on new navigation
    }));

    // Add smooth transition delay
    setTimeout(() => {
      try {
        router.push(path);
      } catch (error) {
        console.error('Navigation error:', error);
        setNavigationState(prev => ({
          ...prev,
          isNavigating: false,
          hasError: true,
          errorCount: prev.errorCount + 1,
        }));
        
        // If too many errors, redirect to home
        if (navigationState.errorCount >= 3) {
          window.location.href = '/';
        }
      }
    }, 100);
  }, [router, navigationState.errorCount]);

  const goBack = useCallback(() => {
    const history = navigationState.navigationHistory;
    if (history.length > 1) {
      setNavigationState(prev => ({
        ...prev,
        isNavigating: true,
      }));
      
      setTimeout(() => {
        router.back();
      }, 100);
    } else {
      // If no history, go to entry page
      navigateTo('/');
    }
  }, [navigationState.navigationHistory, router, navigateTo]);

  const canGoBack = navigationState.navigationHistory.length > 1;

  const clearError = useCallback(() => {
    setNavigationState(prev => ({
      ...prev,
      hasError: false,
    }));
  }, []);

  const reportError = useCallback(() => {
    setNavigationState(prev => ({
      ...prev,
      hasError: true,
      errorCount: prev.errorCount + 1,
    }));
  }, []);

  const contextValue: NavigationContextType = {
    navigationState,
    navigateTo,
    goBack,
    canGoBack,
    clearError,
    reportError,
  };

  return (
    <NavigationContext.Provider value={contextValue}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
}