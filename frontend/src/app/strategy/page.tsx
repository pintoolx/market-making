import { Suspense } from 'react';
import StrategyPage from './StrategyPage';

export default function Page() {
  return <Suspense fallback={<p role="status">Loading strategy…</p>}><StrategyPage /></Suspense>;
}
