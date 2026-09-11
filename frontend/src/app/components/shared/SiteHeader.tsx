import Image from 'next/image';
import Link from 'next/link';
import PrivyAccountButton from './PrivyAccountButton';
import styles from './SiteHeader.module.css';

type Role = 'provider' | 'maker';

// Shared header for /, /studio, /maker and /profile: logo, role switch, account button.
export default function SiteHeader({ role = null, showRoles = true, onReselect }: { role?: Role | null; showRoles?: boolean; onReselect?: () => void }) {
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.logo} aria-label="PinTool home">
        <Image src="/pintoolLogo.svg" alt="PinTool" width={190} height={40} priority />
      </Link>
      <div className={styles.actions}>
        {showRoles && <nav className={styles.roleTabs} aria-label="Role">
          <Link href="/studio" aria-current={role === 'provider' ? 'page' : undefined} onClick={() => role === 'provider' && onReselect?.()}>Provide Strategy</Link>
          <Link href="/maker" aria-current={role === 'maker' ? 'page' : undefined} onClick={() => role === 'maker' && onReselect?.()}>Provide Liquidity</Link>
        </nav>}
        <PrivyAccountButton />
      </div>
    </header>
  );
}
