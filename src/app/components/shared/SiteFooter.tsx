'use client';

import { useState } from 'react';
import LegalModal from './legal/LegalModal';
import PrivacyPolicy from './legal/PrivacyPolicy';
import TermsOfService from './legal/TermsOfService';
import styles from './SiteFooter.module.css';

const UPDATED = 'September 11, 2026';

// Shared footer for the ETHOnline pages (/, /studio, /maker, /profile). Policies open in a dialog.
export default function SiteFooter() {
  const [open, setOpen] = useState<'privacy' | 'terms' | null>(null);

  return (
    <>
      <footer className={styles.footer}>
        <p className={styles.copyright}>&copy; {new Date().getFullYear()} PinTool. All rights reserved.</p>
        <div className={styles.links}>
          <button type="button" onClick={() => setOpen('privacy')}>Privacy Policy</button>
          <button type="button" onClick={() => setOpen('terms')}>Terms of Service</button>
          <a href="https://x.com/PinToolX" target="_blank" rel="noopener noreferrer" className={styles.social} aria-label="PinTool on X">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
        </div>
      </footer>
      <LegalModal title="Privacy Policy" updated={UPDATED} open={open === 'privacy'} onClose={() => setOpen(null)}><PrivacyPolicy /></LegalModal>
      <LegalModal title="Terms of Service" updated={UPDATED} open={open === 'terms'} onClose={() => setOpen(null)}><TermsOfService /></LegalModal>
    </>
  );
}
