import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digestJson } from '../../packages/strategy-builder/src/index.ts';
import { createTrustedWorkflowInput } from '../../packages/builder-service/src/workflow-input.ts';
import { DeliveryNotSentError, DeliveryDeferredError } from '../../packages/builder-service/src/event-delivery.ts';
import { encodeBuilderReport, reportSchema, builderTermsHash } from './builder-cre-protocol.mjs';
import { createCreSimulator, CreNotStartedError } from './builder-cre-simulator.mjs';
import { createBuilderCreChain } from './builder-cre-chain.mjs';

const savedSchema = z.object({ schemaVersion: z.literal(1), candidate: reportSchema,
  bindingDigest: z.string().regex(/^0x[0-9a-f]{64}$/), fromBlock: z.string().regex(/^(0|[1-9][0-9]*)$/).max(78),
  observedAt: z.string().datetime() }).strict();
const reference = sub => ({ owner: sub.owner, draftId: sub.draftId, revision: sub.revision, artifactId: sub.artifactId, consentId: sub.consentId });
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Opt-in simulation adapter for the resident Builder event worker. The public
 * delivery row is the authority for replay identity; inputs are independently
 * loaded and authenticated before either phase. CLI simulator != attested DON.
 */
export function createBuilderCreBridge(pool, profile, options, dependencies = {}) {
  if (options.baseConfig.transport?.profile !== 'cre-simulation' || options.baseConfig.publishMode !== 'don-report' ||
    !['kraken', 'scenario'].includes(options.baseConfig.marketSource)) throw new Error('builder-cre-simulation-profile-required');
  const load = dependencies.load ?? createTrustedWorkflowInput(pool, profile, options);
  const simulate = dependencies.simulate ?? createCreSimulator(options);
  const chain = dependencies.chain ?? createBuilderCreChain(profile, { rpcUrl: options.rpcUrl });
  // A single broadcaster must be exclusive to this adapter. This conservative
  // lane intentionally serializes all Makers on the configured chain.
  const lane = `builder-cre:${profile.chainId}`;
  const configFor = trusted => ({ ...options.baseConfig, ...trusted.config, providerStrategies: [] });
  const check = (candidate, trusted) => {
    const report = reportSchema.parse(candidate), config = trusted.config;
    if (!matches(report.maker, config.maker) || !matches(report.strategyHash, config.strategyHash) || report.chainId !== String(profile.chainId) ||
      !matches(report.guard, profile.guard) || !matches(report.router, profile.router) ||
      !matches(report.token0, profile.tokens[0].address) || !matches(report.token1, profile.tokens[1].address) ||
      Object.entries(config.builderEnvelope).some(([key, cap]) => BigInt(report[key]) > BigInt(cap))) throw new Error('builder-cre-candidate-mismatch');
    return report;
  };
  async function delivery(id) {
    const row = (await pool.query(`SELECT d.*,s.draft_id,s.revision,s.artifact_id,s.consent_id,s.state AS subscription_state,s.generation AS subscription_generation
      FROM builder.report_deliveries d JOIN builder.event_subscriptions s ON s.id=d.subscription_id AND s.owner=d.owner WHERE d.id=$1`, [id])).rows[0];
    if (!row) throw new Error('builder-cre-delivery-missing');
    const saved = savedSchema.parse(row.payload), candidate = encodeBuilderReport({ ...saved.candidate, nonce: String(row.nonce) });
    if (builderTermsHash(saved.candidate) !== row.report_hash || row.owner !== `wallet:${saved.candidate.maker}`) throw new Error('builder-cre-delivery-integrity');
    return { row, saved, candidate };
  }
  async function finish(id, expected, attempt) {
    if (attempt.expected_digest !== expected.digest) throw new Error('builder-cre-attempt-integrity');
    if (attempt.state === 'not-sent') return { status: 'not-broadcast' };
    // Reverify receipts even if an earlier process saved an accepted result.
    const proof = await chain.accepted({ report: expected.report, fromBlock: String(attempt.from_block), transactionHash: attempt.transaction_hash ?? undefined });
    if (!proof) return null;
    await pool.query(`UPDATE builder.cre_delivery_attempts SET state=$2,transaction_hash=$3,outcome=$4,updated_at=clock_timestamp() WHERE delivery_id=$1 AND state IN ('started','accepted','reverted')`,
      [id, proof.status === 'reverted' ? 'reverted' : 'accepted', proof.transactionHash, JSON.stringify(proof)]);
    return proof;
  }
  return {
    async evaluate(input) {
      const trusted = await load(reference(input.subscription));
      const before = await chain.snapshot(trusted.config.maker, trusted.config.strategyHash);
      const payload = { ...trusted.payload, requestId: `builder-${randomUUID()}`, builder: { phase: 'evaluate' } };
      const result = await simulate({ config: configFor(trusted), payload });
      if (result.status !== 'evaluated' || result.requestId !== payload.requestId) throw new Error('builder-cre-evaluation-invalid');
      const candidate = check(result.report, trusted), termsHash = builderTermsHash(candidate);
      if (termsHash !== result.termsHash || Date.now() - Date.parse(result.observedAt) > 300000 || Date.parse(result.observedAt) > Date.now() + 30000) throw new Error('builder-cre-evaluation-stale');
      const latest = await chain.snapshot(candidate.maker, candidate.strategyHash);
      const effective = latest.termsHash === termsHash && (candidate.allowedDirections === '0' ? !matches(latest.activeHash, candidate.strategyHash) : matches(latest.activeHash, candidate.strategyHash));
      if (effective) return { status: 'unchanged', reportHash: termsHash, observedAt: result.observedAt };
      return { status: 'changed', reportHash: termsHash, observedAt: result.observedAt, nonceFloor: latest.nonceFloor, chainStateChanged: true,
        report: { schemaVersion: 1, candidate, bindingDigest: trusted.bindingDigest, fromBlock: before.fromBlock, observedAt: result.observedAt } };
    },
    async deliver(input) {
      const client = await pool.connect();
      let locked = false, destroy = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lane])).rows[0].locked;
        if (!locked) throw new DeliveryDeferredError('builder-cre-broadcaster-busy', 503);
        const { row, saved, candidate } = await delivery(input.deliveryId);
        if (row.owner !== input.subscription.owner || row.subscription_id !== input.subscription.id || String(row.nonce) !== input.nonce ||
          row.report_hash !== input.reportHash || digestJson(row.payload) !== digestJson(input.report)) throw new DeliveryNotSentError('builder-cre-request-mismatch', 400);
        const prior = (await client.query('SELECT * FROM builder.cre_delivery_attempts WHERE delivery_id=$1', [input.deliveryId])).rows[0];
        if (prior) {
          const recovered = await finish(input.deliveryId, candidate, prior);
          if (recovered && !('status' in recovered)) return recovered;
          throw new Error('builder-cre-existing-attempt-requires-reconciliation');
        }
        if ((await client.query("SELECT delivery_id FROM builder.cre_delivery_attempts WHERE lane=$1 AND state='started'", [lane])).rowCount)
          throw new DeliveryDeferredError('builder-cre-broadcaster-unresolved', 503);
        if (row.status !== 'broadcast' || row.subscription_state !== 'enabled' || Number(row.generation) !== Number(row.subscription_generation))
          throw new DeliveryNotSentError('builder-cre-subscription-stale', 409);
        const trusted = await load({ owner: row.owner, draftId: row.draft_id, revision: Number(row.revision), artifactId: row.artifact_id, consentId: row.consent_id });
        check(candidate.report, trusted);
        if (saved.bindingDigest !== trusted.bindingDigest) throw new DeliveryNotSentError('builder-cre-binding-changed', 409);
        await chain.snapshot(candidate.report.maker, candidate.report.strategyHash);
        const payload = { ...trusted.payload, requestId: `builder-${input.deliveryId}`, builder: { phase: 'deliver', deliveryId: input.deliveryId,
          nonce: input.nonce, validAfter: candidate.report.validAfter, termsHash: input.reportHash } };
        // Commit the ambiguity fence before starting a process that might send.
        await client.query(`INSERT INTO builder.cre_delivery_attempts(delivery_id,lane,state,expected_digest,from_block) VALUES($1,$2,'started',$3,$4)`,
          [input.deliveryId, lane, candidate.digest, saved.fromBlock]);
        let result;
        try { result = await simulate({ config: configFor(trusted), payload }); }
        catch (error) {
          if (error instanceof CreNotStartedError) {
            await client.query("UPDATE builder.cre_delivery_attempts SET state='not-sent',outcome=$2,updated_at=clock_timestamp() WHERE delivery_id=$1", [input.deliveryId, JSON.stringify({ reason: 'process-not-started' })]);
          }
          throw new Error('builder-cre-reconciliation-required');
        }
        if (result.status === 'stale' || result.status === 'already-effective') {
          await client.query("UPDATE builder.cre_delivery_attempts SET state='not-sent',outcome=$2,updated_at=clock_timestamp() WHERE delivery_id=$1", [input.deliveryId, JSON.stringify({ reason: result.status })]);
          throw new Error('builder-cre-candidate-not-sent');
        }
        if (result.status !== 'accepted' || result.reportDigest !== candidate.digest || result.nonce !== input.nonce) throw new Error('builder-cre-receipt-mismatch');
        await client.query('UPDATE builder.cre_delivery_attempts SET transaction_hash=$2,updated_at=clock_timestamp() WHERE delivery_id=$1', [input.deliveryId, result.transactionHash]);
        const attempt = (await client.query('SELECT * FROM builder.cre_delivery_attempts WHERE delivery_id=$1', [input.deliveryId])).rows[0];
        const proof = await finish(input.deliveryId, candidate, attempt);
        if (!proof || 'status' in proof) throw new Error('builder-cre-reconciliation-required');
        return proof;
      } finally {
        if (locked) try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lane]); } catch { destroy = true; }
        client.release(destroy);
      }
    },
    async reconcile(input) {
      const { row, candidate } = await delivery(input.deliveryId);
      if (row.owner !== input.subscription.owner || row.subscription_id !== input.subscription.id || row.report_hash !== input.reportHash || String(row.nonce) !== input.nonce)
        throw new Error('builder-cre-request-mismatch');
      const attempt = (await pool.query('SELECT * FROM builder.cre_delivery_attempts WHERE delivery_id=$1', [input.deliveryId])).rows[0];
      // Without an attempt the process could still be preparing it. Absence is
      // not evidence that a delayed request has been fenced off.
      return attempt ? finish(input.deliveryId, candidate, attempt) : null;
    },
  };
}
