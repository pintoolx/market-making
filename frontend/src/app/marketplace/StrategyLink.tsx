'use client';
import Link from 'next/link';
import { rememberMarketplace, strategyHref } from './strategyLinks';
import secondary from '../components/shared/Secondary.module.css';

export default function StrategyLink({ id, ens, children = 'View strategy' }: { id: string; ens?: string; children?: React.ReactNode }) {
  return <Link href={strategyHref(id, ens)} onClick={rememberMarketplace} className={secondary.secondary}>{children}</Link>;
}
