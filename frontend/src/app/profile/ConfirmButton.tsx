'use client';

import { useState } from 'react';
import Secondary from '../components/shared/Secondary';

// Two-step button for actions that can't be undone: the first click asks, the second one acts.
export default function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Secondary onClick={() => setAsking(true)}>{label}</Secondary>;
  return <>
    <Secondary onClick={onConfirm}>{confirmLabel}</Secondary>
    <Secondary onClick={() => setAsking(false)}>Keep</Secondary>
  </>;
}
