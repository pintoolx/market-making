'use client';
import SiteHeader from '../../components/shared/SiteHeader';
import SiteFooter from '../../components/shared/SiteFooter';
import { useAccount } from '../../providers/useAccount';
import { EnsPlatformSetup } from '../EnsWorkspace';
import styles from '../../marketplace/page.module.css';
import aqua from '../../marketplace/aqua.module.css';
export default function EnsSetupPage() {
  const account = useAccount();
  return <div className={`${styles.page} ${aqua.page}`}><SiteHeader role="names" /><main className={`${styles.main} ${aqua.flow}`}><EnsPlatformSetup key={account.address} account={account} /></main><SiteFooter /></div>;
}
