// Shared component prop interfaces

import { ReactNode } from 'react';

// Shared layout component props
export interface NavigationProps {
  currentPage: 'entry' | 'workflows';
  showBackToHome?: boolean;
}

export interface LayoutProps {
  children: ReactNode;
  showNavigation?: boolean;
  pageType: 'entry' | 'workflows';
}

// Error boundary types
export interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

// Common page types
export type PageType = 'entry' | 'workflows';
export type UserRole = 'workflows';