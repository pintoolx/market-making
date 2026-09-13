// Disposable local DB + synthetic wallets/policy + REAL CRE CLI evaluation.
// No report delivery, asset transaction, production DB or real credential read.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { database, migrate, createStore, createArtifacts, createAutomation, createEventDelivery } from '../../packages/builder-service/src/index.ts';
import { createTemplates } from '../../packages/builder-service/src/templates.ts';
import { sepoliaStandingProfile as profile, defaultTemplatePermissions, publicationMessage } from '../../packages/strategy-builder/src/index.ts';
import { createBuilderCreBridge } from '../../orchestrator/src/builder-cre-bridge.mjs';
import { sealProviderStrategy } from '../../frontend/src/app/marketplace/confidentialEnvelope.ts';
const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Only a disposable localhost database is allowed');
const databaseName = 'pintool_builder_test_' + randomUUID().replaceAll('-', '');
const admin = database(url.toString());
let pool;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = '/' + databaseName; pool = database(url.toString()); await migrate(pool);
  const origin = 'http://localhost:3311', key = new Uint8Array(32).fill(7); // Public encryption fixture.
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const publicKey = hex(x25519.getPublicKey(key)), provider = privateKeyToAccount(generatePrivateKey()), maker = privateKeyToAccount(generatePrivateKey());
  const providerOwner = `wallet:${provider.address.toLowerCase()}`, makerOwner = `wallet:${maker.address.toLowerCase()}`;
  const store = createStore(pool, profile.id), templates = createTemplates(pool, profile, { origin, workflowPublicKey: publicKey });
  const created = await store.create(providerOwner, randomUUID(), { title: 'Public CRE integration fixture', kind: 'template' });
  const { draft } = await store.patch(providerOwner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: { spec: {
    baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400,
    guardEnvelope: { maxAmountBasePerSwap: '1000000000000000', maxAmountQuotePerSwap: '2500000', maxPostBalanceBase: '10000000000000000', maxPostBalanceQuote: '25000000' },
  } } });
  const { intent } = await templates.prepare(providerOwner, randomUUID(), { draftId: draft.id, expectedRevision: draft.revision, templateId: null, permissions: defaultTemplatePermissions });
  const policy = { schemaVersion: 1, strategyId: intent.encryption.strategyId, rules: [{ id: 'public-fixture', when: {}, allowMakerBuyToken0: true, allowMakerSellToken0: true,
    maxAmount0PerSwap: '500000000000000', maxAmount1PerSwap: '1000000', ttlSec: 300 }], inventory: { maxBalance0: '20000000000000000', maxBalance1: '50000000' } };
  const envelope = sealProviderStrategy(policy, publicKey, provider.address);
  const published = await templates.publish(providerOwner, randomUUID(), { intentId: intent.id, envelope, signature: await provider.signMessage({ message: publicationMessage(intent, envelope) }) });
  const instance = await templates.instantiate(makerOwner, randomUUID(), { templateId: published.template.templateId, version: published.template.version, digest: published.digest,
    allocations: { baseAtomic: '1000000000000000', quoteAtomic: '2500000' } });
  const artifact = await createArtifacts(pool, profile).compile(makerOwner, randomUUID(), { draftId: instance.draft.id, expectedRevision: instance.draft.revision });
  const automation = createAutomation(pool, profile), prepared = await automation.prepare(makerOwner, randomUUID(), { draftId: instance.draft.id, expectedRevision: instance.draft.revision, artifactId: artifact.artifactId,
    outagePolicy: { sources: ['probe.market'], maxAgeSeconds: 300, onRecovery: 'reevaluate' } });
  const { consent } = await automation.confirm(makerOwner, randomUUID(), { intentId: prepared.intent.id, digest: prepared.digest, signature: await maker.signMessage({ message: prepared.intent.message }) });
  const baseConfig = JSON.parse(await readFile(new URL('../market-maker-auth/config.staging.json', import.meta.url), 'utf8'));
  const env = { ...process.env, TZ: 'UTC', SECRET_ENVELOPE_PRIVATE_KEY: hex(key), SECRET_PROVIDER_STRATEGY: JSON.stringify(policy), SECRET_PROVIDER_STRATEGY_DEFENSIVE: JSON.stringify(policy),
    SECRET_MAKER_LIMITS: JSON.stringify({ schemaVersion: 1, maxBudget1: '0', maxToken0ShareBps: 0, maxAmount0PerSwap: '0', maxAmount1PerSwap: '0', maxTtlSec: 300 }) };
  delete env.CRE_ETH_PRIVATE_KEY;
  const bridge = createBuilderCreBridge(pool, profile, { baseConfig, origin, workflowPublicKey: publicKey,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', projectDirectory: fileURLToPath(new URL('../', import.meta.url)), env, broadcastEnabled: false });
  const events = createEventDelivery(pool, profile, bridge);
  await events.health('probe.market', { health: 'healthy', cursor: {}, observedAt: new Date().toISOString() });
  const { subscription } = await events.enable(makerOwner, randomUUID(), { draftId: instance.draft.id, expectedRevision: instance.draft.revision, artifactId: artifact.artifactId, consentId: consent.id });
  const job = await events.claimEvaluation(300000); assert.ok(job); assert.equal(job.subscriptionId, subscription.id);
  const evaluated = await events.evaluate(job.id, job.token);
  assert.equal(evaluated.result.status, 'changed', JSON.stringify(evaluated)); assert.equal(evaluated.nonce, '1');
  const saved = (await pool.query('SELECT nonce,status,payload FROM builder.report_deliveries WHERE id=$1', [evaluated.deliveryId])).rows[0];
  assert.equal(saved.status, 'pending'); assert.equal(saved.payload.candidate.allowedDirections, '3');
  assert.equal(saved.payload.candidate.maxAmount0PerSwap, '500000000000000'); assert.equal(saved.payload.candidate.maxAmount1PerSwap, '1000000');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM builder.cre_delivery_attempts')).rows[0].n, 0);
  const evidence = { mode: 'real-cli-and-postgres-evaluation-with-live-guard-reads', publicMarketSource: 'kraken-and-sepolia', observedGuardBlock: saved.payload.fromBlock,
    chainWrites: 0, providerSignatureVerified: true, makerConsentVerified: true, firstActivationQueued: true,
    allocatedNonce: String(saved.nonce), deliveryStatus: saved.status, publicCandidate: saved.payload.candidate };
  assert.equal(await events.scheduleHealthEvaluations(), 0);
  await events.health('probe.market', { health: 'error', cursor: {}, observedAt: new Date().toISOString() });
  assert.equal(await events.scheduleHealthEvaluations(), 1);
  // Outage authorization must not depend on reading/decrypting private inputs.
  env.SECRET_ENVELOPE_PRIVATE_KEY = 'deliberately-unusable-public-fixture';
  const pausedJob = await events.claimEvaluation(300000), paused = await events.evaluate(pausedJob.id, pausedJob.token);
  assert.equal(paused.result.status, 'changed', JSON.stringify(paused));
  const pauseRow = (await pool.query('SELECT payload,nonce::text FROM builder.report_deliveries WHERE id=$1', [paused.deliveryId])).rows[0];
  assert.equal(pauseRow.payload.candidate.allowedDirections, '0');
  for (const k of ['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1']) assert.equal(pauseRow.payload.candidate[k], '0');
  env.SECRET_ENVELOPE_PRIVATE_KEY = hex(key);
  await events.health('probe.market', { health: 'recovered', cursor: {}, observedAt: new Date().toISOString() });
  assert.equal(await createEventDelivery(pool, profile, bridge).scheduleHealthEvaluations(), 1);
  const recoveryJob = await events.claimEvaluation(300000), recovery = await events.evaluate(recoveryJob.id, recoveryJob.token);
  assert.equal(recovery.result.status, 'changed', JSON.stringify(recovery));
  const recoveryRow = (await pool.query('SELECT payload,nonce::text FROM builder.report_deliveries WHERE id=$1', [recovery.deliveryId])).rows[0];
  assert.equal(recoveryRow.payload.candidate.allowedDirections, '3');
  evidence.signedOutagePolicy = consent.outagePolicy;
  evidence.outageCandidates = [pauseRow, recoveryRow].map(r => ({ nonce: r.nonce, report: r.payload.candidate }));
  evidence.pauseWithoutDecryptionKey = true;
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end();
}
