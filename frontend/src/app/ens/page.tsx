'use client';
import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import { useAccount } from '../providers/useAccount';
import EnsWorkspace from './EnsWorkspace';
import EnsPublisher from './EnsPublisher';
import styles from '../marketplace/page.module.css';
import aqua from '../marketplace/aqua.module.css';
export default function EnsPage() {
  const account = useAccount();
  return <div className={`${styles.page} ${aqua.page}`}><SiteHeader role="names" /><main className={`${styles.main} ${aqua.flow}`}><EnsWorkspace key={account.address} account={account} /><EnsPublisher key={account.address} account={account} /></main><SiteFooter /></div>;
}
