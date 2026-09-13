'use client';

import { useEffect, useState } from 'react';
import type { BuilderClient, Draft, RequirementReceipt, RequirementReview } from './client';
import { BuilderError } from './client';
import BuilderDialog from './BuilderDialog';
import styles from './builder.module.css';

type Decision = 'confirm' | 'accept-limitation';

export default function RequirementReviewDialog({ api, draft, onClose, onComplete }: {
  api: BuilderClient; draft: Draft; onClose(): void; onComplete(receipt: RequirementReceipt): void;
}) {
  const [review, setReview] = useState<RequirementReview | null>(null), [digest, setDigest] = useState<`0x${string}` | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({}), [busy, setBusy] = useState('Preparing requirement review'), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api.prepareRequirementReview(draft, crypto.randomUUID()).then(result => {
      if (!live) return;
      setReview(result.review); setDigest(result.digest); setBusy('');
    }).catch(e => {
      if (!live) return;
      setError(e instanceof BuilderError ? e.message : 'Unable to prepare the requirement review.'); setBusy('');
    });
    return () => { live = false; };
  }, [api, draft]);
  const failure = (e: unknown) => setError(e instanceof BuilderError ? e.message : 'Requirement review did not complete. Try again.');
  async function confirm() {
    if (!review || !digest || busy || Object.keys(decisions).length !== review.requirements.length) return;
    setBusy('Saving requirement decisions'); setError('');
    try {
      const result = await api.confirmRequirementReview(review.id, digest,
        review.requirements.map(row => ({ requirementId: row.id, decision: decisions[row.id]! })), crypto.randomUUID());
      onComplete(result.receipt);
    } catch (e) { failure(e); setBusy(''); }
  }
  return <BuilderDialog title="Review strategy requirements" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {busy && !review ? <p role="status">{busy}</p> : review ? <>
      <p className={styles.helper}>This confirms an interpretation of the public strategy. It does not prove a CRE report, wallet funding or onchain authorization. The review expires {new Date(review.expiresAt).toLocaleString('en-US')}.</p>
      <div className={styles.requirementReview}>
        {review.requirements.map(row => {
          const canConfirm = row.criteria.every(c => c.enforcement !== 'unsupported' && c.matchesDraft !== false);
          const hasLimitation = row.criteria.some(c => c.enforcement === 'unsupported' || c.matchesDraft === false);
          return <article key={row.id} className={styles.requirementReviewRow}>
            <header><strong>{row.priority === 'must' ? 'Required' : 'Preferred'} · {row.text}</strong><small>Source: {row.sourceMessageId}</small></header>
            {row.criteria.map((criterion, index) => <div className={styles.requirementCriterion} key={index}>
              <p>{criterion.interpretation}</p>
              <small>Current value: {criterion.actual ?? 'No comparable value'} · Evidence: {criterion.evidence}</small>
              <p className={styles.helper}>{criterion.limitation}</p>
            </div>)}
            <label>Your decision<select value={decisions[row.id] ?? ''} onChange={event => setDecisions(current => ({ ...current, [row.id]: event.target.value as Decision }))}>
              <option value="" disabled>Choose one</option>
              {canConfirm && <option value="confirm">Confirm this interpretation</option>}
              {hasLimitation && <option value="accept-limitation">Accept this limitation and continue</option>}
              {!hasLimitation && <option value="accept-limitation">Accept the stated product limitation</option>}
            </select></label>
          </article>;
        })}
      </div>
      <div className={styles.dialogFooter}><p className={styles.helper}>Changing any strategy parameter invalidates this review and requires a new one.</p>
        <div className={styles.actions}><button disabled={!!busy} onClick={onClose}>Review later</button>
          <button className={styles.primary} disabled={!!busy || Object.keys(decisions).length !== review.requirements.length} onClick={() => void confirm()}>{busy || 'Confirm all requirements'}</button></div>
      </div>
    </> : <p role="status">{error || 'Preparing public criteria…'}</p>}
  </BuilderDialog>;
}
