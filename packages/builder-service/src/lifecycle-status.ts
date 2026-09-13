import type { Pool } from 'pg'
import { idSchema } from '@pintool/strategy-builder'
import { readOwnedDraft } from './draft-persistence.ts'
import { readActiveAutomationConsent } from './automation.ts'
import { readOutageState } from './outage-policy.ts'

/** Public evidence projection for the design agent. No policy, signatures,
 * ciphertext, request calldata or secret configuration enters model context. */
export async function readLifecycleStatus(pool: Pool, owner: string, draftId: string) {
  idSchema.parse(draftId)
  const draft = await readOwnedDraft(pool, owner, draftId)
  if (draft.kind !== 'maker') return { stage: 'provider-design', walletSigning: 'maker-required', chainReadiness: 'not-checked' }
  const consent = await readActiveAutomationConsent(pool, owner, draft.id, draft.revision)
  const health = await readOutageState(pool, consent?.outagePolicy)
  const subscription = (await pool.query(`SELECT id,state,revision::text,last_evaluated_at FROM builder.event_subscriptions
    WHERE owner=$1 AND draft_id=$2 ORDER BY created_at DESC LIMIT 1`, [owner, draftId])).rows[0]
  const reports = (await pool.query(`SELECT s.revision::text,d.nonce::text,d.status,d.transaction_hash,
    d.payload->'candidate'->>'allowedDirections' AS allowed_directions,d.updated_at
    FROM builder.report_deliveries d JOIN builder.event_subscriptions s ON s.id=d.subscription_id AND s.owner=d.owner
    WHERE d.owner=$1 AND s.draft_id=$2 ORDER BY d.created_at DESC LIMIT 10`, [owner, draftId])).rows
  const transactions = (await pool.query(`SELECT p.revision::text,p.strategy_hash,p.kind,w.step,w.state,w.transaction_hash,
    w.evidence->>'blockNumber' AS receipt_block,w.updated_at FROM builder.wallet_executions w
    JOIN builder.transaction_plans p ON p.id=w.plan_id AND p.owner=w.owner WHERE w.owner=$1 AND p.draft_id=$2 ORDER BY w.created_at DESC LIMIT 12`, [owner, draftId])).rows
  return { stage: 'maker', revision: draft.revision, consentActive: !!consent,
    outagePauseConsented: !!consent?.outagePolicy, monitoring: health, subscription: subscription ?? null, reports, transactions,
    chainReadiness: 'not-checked', limitation: 'These are recorded outcomes at their indicated revision/block. Check current inventory and Guard state before claiming that trading is available. Pending or superseded records are not current success.' }
}
