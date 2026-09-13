'use client';

import { useState } from 'react';
import aqua from '../marketplace/aqua.module.css';

// Addresses stay readable in context; the adjacent control copies the full value.
export default function CopyAddress({ address, short = false }: { address: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: nothing to do */ }
  };

  return (
    <span className={aqua.copyAddress}>
      <code title={short ? address : undefined}>{short ? `${address.slice(0, 6)}…${address.slice(-4)}` : address}</code>
      <button type="button" onClick={copy} title={copied ? 'Copied' : 'Copy address'} aria-label={copied ? 'Address copied' : `Copy address ${address}`}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {copied
            ? <path d="M13.333 4 6 11.333 2.667 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            : <><path d="M13.333 6H7.333C6.597 6 6 6.597 6 7.333v6c0 .737.597 1.334 1.333 1.334h6c.737 0 1.334-.597 1.334-1.334v-6C14.667 6.597 14.07 6 13.333 6Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.333 10h-.666A1.333 1.333 0 0 1 1.333 8.667v-6c0-.737.597-1.334 1.334-1.334h6C9.403 1.333 10 1.93 10 2.667v.666" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>}
        </svg>
      </button>
    </span>
  );
}
