'use client';
import Link from 'next/link';
import { rememberMarketplace, strategyHref } from './strategyLinks';
import primary from '../components/shared/Primary.module.css';

export default function StrategyLink({ id, ens, children = 'View strategy' }: { id: string; ens?: string; children?: React.ReactNode }) {
  return <Link href={strategyHref(id, ens)} onClick={rememberMarketplace} className={primary.primary}>{children}</Link>;
}
