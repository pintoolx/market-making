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
  const [decisions, setDecisions] = useState<Record<string, Decision>>({}), [busy, setBusy] = useState('準備需求審閱'), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api.prepareRequirementReview(draft, crypto.randomUUID()).then(result => {
      if (!live) return;
      setReview(result.review); setDigest(result.digest); setBusy('');
    }).catch(e => {
      if (!live) return;
      setError(e instanceof BuilderError ? e.message : '無法準備需求審閱。'); setBusy('');
    });
    return () => { live = false; };
  }, [api, draft]);
  const failure = (e: unknown) => setError(e instanceof BuilderError ? e.message : '需求確認未完成，請重試。');
  async function confirm() {
    if (!review || !digest || busy || Object.keys(decisions).length !== review.requirements.length) return;
    setBusy('保存需求確認'); setError('');
    try {
      const result = await api.confirmRequirementReview(review.id, digest,
        review.requirements.map(row => ({ requirementId: row.id, decision: decisions[row.id]! })), crypto.randomUUID());
      onComplete(result.receipt);
    } catch (e) { failure(e); setBusy(''); }
  }
  return <BuilderDialog title="逐項確認策略條件" onClose={onClose}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {busy && !review ? <p role="status">{busy}</p> : review ? <>
      <p className={styles.helper}>這是對公開策略解讀的確認，並不代表已取得 CRE report、錢包資金或鏈上授權。審閱有效至 {new Date(review.expiresAt).toLocaleString('zh-TW')}。</p>
      <div className={styles.requirementReview}>
        {review.requirements.map(row => {
          const canConfirm = row.criteria.every(c => c.enforcement !== 'unsupported' && c.matchesDraft !== false);
          const hasLimitation = row.criteria.some(c => c.enforcement === 'unsupported' || c.matchesDraft === false);
          return <article key={row.id} className={styles.requirementReviewRow}>
            <header><strong>{row.priority === 'must' ? '必要' : '偏好'} · {row.text}</strong><small>來源：{row.sourceMessageId}</small></header>
            {row.criteria.map((criterion, index) => <div className={styles.requirementCriterion} key={index}>
              <p>{criterion.interpretation}</p>
              <small>目前值：{criterion.actual ?? '沒有可比較值'} · 證據：{criterion.evidence}</small>
              <p className={styles.helper}>{criterion.limitation}</p>
            </div>)}
            <label>你的決定<select value={decisions[row.id] ?? ''} onChange={event => setDecisions(current => ({ ...current, [row.id]: event.target.value as Decision }))}>
              <option value="" disabled>請選擇</option>
              {canConfirm && <option value="confirm">符合這個解讀</option>}
              {hasLimitation && <option value="accept-limitation">接受這項限制，繼續保存</option>}
              {!hasLimitation && <option value="accept-limitation">接受已說明的產品限制</option>}
            </select></label>
          </article>;
        })}
      </div>
      <div className={styles.dialogFooter}><p className={styles.helper}>修改任何策略參數後，這份確認會失效，必須重新審閱。</p>
        <div className={styles.actions}><button disabled={!!busy} onClick={onClose}>稍後確認</button>
          <button className={styles.primary} disabled={!!busy || Object.keys(decisions).length !== review.requirements.length} onClick={() => void confirm()}>{busy || '確認所有條件'}</button></div>
      </div>
    </> : <p role="status">{error || '正在準備公開條件…'}</p>}
  </BuilderDialog>;
}
