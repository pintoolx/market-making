'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePrivy } from '@privy-io/react-auth';
import { PRIVY_APP_ID } from '../../providers/PrivyProvider';
import styles from './PrivyAccountButton.module.css';

function shortAddress(address?: string) {
  return address ? `${address.slice(0, 5)}…${address.slice(-4)}` : 'Account';
}

// Wallet icon drawn in the same 16px, 2px-stroke style as /plus-square.svg.
function WalletIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12.667 4.667H3.333C2.597 4.667 2 5.264 2 6v6.667C2 13.403 2.597 14 3.333 14h9.334c.736 0 1.333-.597 1.333-1.333V6c0-.736-.597-1.333-1.333-1.333Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.333 4.667V3.333C11.333 2.597 10.736 2 10 2H4c-1.105 0-2 .895-2 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 9.333h.007" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 8a2.667 2.667 0 1 0 0-5.333A2.667 2.667 0 0 0 8 8Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.333 14c0-2.21-2.388-4-5.333-4s-5.333 1.79-5.333 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 14H3.333A1.333 1.333 0 0 1 2 12.667V3.333A1.333 1.333 0 0 1 3.333 2H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.667 11.333 14 8l-3.333-3.333M14 8H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Signed in: the address opens a small menu with Profile and Log out.
function AccountMenu() {
  const { user, logout } = usePrivy();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className={styles.anchor} ref={root}>
      <button className={styles.button} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <WalletIcon />{shortAddress(user?.wallet?.address)}
      </button>
      {open && <div className={styles.menu} role="menu">
        <Link className={styles.menuItem} role="menuitem" href="/profile" onClick={() => setOpen(false)}><ProfileIcon />Profile</Link>
        <button className={styles.menuItem} role="menuitem" type="button" onClick={() => { setOpen(false); void logout(); }}><LogoutIcon />Log out</button>
      </div>}
    </div>
  );
}

function ConnectedAccountButton() {
  const { ready, authenticated, login } = usePrivy();
  if (authenticated) return <AccountMenu />;
  return <button className={styles.button} type="button" disabled={!ready} onClick={login}><WalletIcon />Log in</button>;
}

export default function PrivyAccountButton() {
  if (!PRIVY_APP_ID) return <button className={styles.button} type="button" disabled title="Login is temporarily unavailable"><WalletIcon />Login unavailable</button>;
  return <ConnectedAccountButton />;
}
