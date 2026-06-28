'use client';

import { ToastProvider } from '../components/shared/Toast';

export default function ToastProviderWrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
