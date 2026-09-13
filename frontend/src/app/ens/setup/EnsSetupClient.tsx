'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from '../../components/shared/SiteHeader';
import SiteFooter from '../../components/shared/SiteFooter';
import Primary from '../../components/shared/Primary';
import { useAccount, type Account } from '../../providers/useAccount';
import { ensTransactions, type EnsProgress, type RegistrationPlan } from '../../../../../shared/ens/transactions.mjs';
import { ensClient, ensError, getEnsConfig, getEnsStatus } from '../ensClient';
import { ActionFeedback } from '../EnsWorkspace';
import pageStyles from '../../marketplace/page.module.css';
import aqua from '../../marketplace/aqua.module.css';
import styles from '../ens.module.css';

export default function EnsSetupClient() {
  const account = useAccount();
  return <div className={`${pageStyles.page} ${aqua.page}`}><SiteHeader role="provider" /><main className={`${pageStyles.main} ${aqua.flow}`}><EnsPlatformSetup key={account.address} account={account} /></main><SiteFooter /></div>;
}

function EnsPlatformSetup({ account }: { account: Account }) {
  const [root, setRoot] = useState('');
  const [plan, setPlan] = useState<RegistrationPlan>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<EnsProgress | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [now, setNow] = useState(0);
  const key = `pintool.ens.registration.11155111.${root}.${account.address?.toLowerCase()}`;
  useEffect(() => { getEnsConfig().then(c => setRoot(c.rootName)).catch(() => setError('Could not load the platform name. Reload when the service is available.')); }, []);
  useEffect(() => { try { setPlan(JSON.parse(localStorage.getItem(key) || '{}')); } catch { setPlan({}); } setError(''); setSuccess(''); }, [key]);
  useEffect(() => { setNow(Date.now() / 1000); const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer); }, []);
  const persist = (p: RegistrationPlan) => { setPlan(p); localStorage.setItem(key, JSON.stringify(p)); };
  const run = async (step: 'prepare' | 'register' | 'enable') => {
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!account.ensWallet) throw new Error('Connect the platform owner wallet.');
      const tx = ensTransactions(ensClient, await account.ensWallet(), setProgress);
      if (step === 'prepare') { const next = await tx.prepareRoot(root, plan, persist); persist(next); setSuccess(next.registered ? 'You already own this name. Enable Provider registration next.' : 'Commitment confirmed. Complete registration when the waiting period ends.'); }
      if (step === 'register') { await tx.registerRoot(root, plan); persist({ ...plan, registered: true }); setSuccess('Platform name registered. Enable Provider registration next.'); }
      if (step === 'enable') { persist(await tx.enablePlatform(root, plan, persist)); await getEnsStatus(); setSuccess('Platform verified. Providers can now claim their namespaces.'); }
    } catch (e) { setError(ensError(e)); }
    finally { setBusy(false); }
  };
  return <section className={`${aqua.panel} ${styles.workspace}`} aria-busy={busy}>
    <h1>Set up {root || 'your platform name'}</h1>
    <p>The platform owner completes this once on Ethereum Sepolia. Each transaction is reviewed in your wallet. Providers then claim their own names.</p>
    <ol className={styles.setupSteps}>
      <li><strong>Prepare the name</strong><p>Create the namespace registry and resolver, mint the ENS test fee token if needed, approve the registration fee, and commit the name.</p><Primary disabled={busy || !root || !account.authenticated} onClick={() => void run('prepare')}>Prepare registration</Primary></li>
      <li><strong>Register the name</strong><p>{plan.readyAt && now < plan.readyAt ? `ENS commitment waiting period: ${Math.ceil(plan.readyAt - now)} seconds remaining.` : 'After the ENS waiting period, register the name for one year.'}</p><Primary disabled={busy || !plan.secret || Boolean(plan.readyAt && now < plan.readyAt) || plan.registered} onClick={() => void run('register')}>Register platform name</Primary></li>
      <li><strong>Enable Provider names</strong><p>Deploy the PinTool registrar, grant it permission to register subnames, and publish its address in ENS.</p><Primary disabled={busy || !account.authenticated || !root} onClick={() => void run('enable')}>Enable Provider registration</Primary></li>
    </ol>
    {!account.authenticated && <Primary onClick={account.login}>Connect platform owner wallet</Primary>}
    <p className={aqua.hint}>ENS uses its own MockUSDC fee token on Sepolia. This setup never approves the WETH or Circle USDC used by Maker strategies. The parent remains managed by the platform owner.</p>
    <ActionFeedback progress={progress} error={error} success={success} />
    <Link href="/profile?tab=account">Manage your Provider profile →</Link>
  </section>;
}
