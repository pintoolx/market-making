'use client';

import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import { useAccount } from '../providers/useAccount';
import BuilderWorkspace from './BuilderWorkspace';
import layout from '../marketplace/page.module.css';
import aqua from '../marketplace/aqua.module.css';

export default function BuilderPage() {
  const account = useAccount();
  return <div className={`${layout.page} ${aqua.page}`}>
    <SiteHeader role="provider" showRoles />
    <main className={layout.mainScroll}><div className={layout.main}><BuilderWorkspace identity={account} /></div></main>
    <SiteFooter />
  </div>;
}
