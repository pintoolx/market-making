import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, SignJWT } from 'jose';
import { MockLanguageModelV4 } from 'ai/test';
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import { database, migrate, createStore, createTurns, createSimulations, builderHandler, runDesignTurn, runSimulation } from '../../src/index.ts';
import { createPrivyVerifier } from '../../src/privy.ts';
import { fixtureInventory, fixtureSimulation, fixtureSimulationControl } from './preparation-fixture.mjs';

const origin = 'http://127.0.0.1:3311', appId = 'pintool-browser-test', name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '');
if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Disposable localhost PostgreSQL required');
const admin = database(url.toString());
await admin.query(`CREATE DATABASE "${name}"`);
url.pathname = '/' + name;
const pool = database(url.toString());
await migrate(pool);
const keys = await generateKeyPair('ES256');
const { publicKey: workflowPublicKey, checkFixturePolicy } = await import(new URL('../../../../.cache/builder/private-check.mjs', import.meta.url));
const token = await new SignJWT({ sid: 'browser-session' }).setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).setIssuer('privy.io')
  .setAudience(appId).setSubject('did:privy:browser').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
const handler = builderHandler(pool, { origin, chainId: 11155111, profileId: profile.id, privyAppId: appId, designEnabled: true, simulationEnabled: true },
  { verifyPrivy: createPrivyVerifier(appId, keys.publicKey), templates: { workflowPublicKey }, inventoryAdapter: fixtureInventory });
const store = createStore(pool, profile.id), turns = createTurns(pool), shutdown = new AbortController();
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/fixture/token') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token })); return; }
    if (req.url?.startsWith('/fixture/simulation-control?')) {
      const params = new URL(req.url, origin).searchParams;
      fixtureSimulationControl.delayMs = params.get('slow') === 'true' ? 8000 : 1000;
      fixtureSimulationControl.skip = params.get('skip') === 'true';
      res.end('Synthetic worker configured'); return;
    }
    if (req.url === '/fixture/policy-check') {
      const rows = (await pool.query(`SELECT p.envelope,v.payload FROM builder_private.provider_policies p
        JOIN builder.template_versions v ON v.template_id=p.template_id AND v.version=p.version ORDER BY v.created_at DESC LIMIT 1`)).rows;
      if (!rows[0]) { res.statusCode = 404; res.end('No fixture publication'); return; }
      const v = rows[0].payload;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(checkFixturePolicy(rows[0].envelope, v.provider, `${v.templateId}.v${v.version}`))); return;
    }
    if (await handler(req, res)) return;
    if (req.url === '/hero.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end(await readFile(new URL('../../../../frontend/public/hero.svg', import.meta.url))); return; }
    if (req.url === '/entry.js' || req.url === '/entry.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL('../../../../.cache/builder/browser' + req.url, import.meta.url))); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pintool local UI test</title><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script></html>');
  } catch { res.statusCode = 500; res.end('Test request failed'); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3311, '127.0.0.1', resolve); });
} catch {
  await pool.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  throw new Error('Owned browser fixture could not listen on port 3311');
}
console.log('Builder browser fixture ready on localhost:3311');

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function fixtureModel(draft, content) {
  const slow = content.includes('Slowly'), narrow = content.includes('2700'), partial = content.includes('Single field');
  const edits = narrow ? [{ field: 'maxPrice', value: '2700' }] : [
    { field: 'baseToken', value: 'WETH' }, { field: 'quoteToken', value: 'USDC' }, { field: 'curve', value: 'concentrated' },
    { field: 'minPrice', value: '2200' }, { field: 'maxPrice', value: '2800' }, { field: 'feeBps', value: '0' },
    { field: 'maxAmountBasePerSwap', value: '0.05' }, { field: 'maxAmountQuotePerSwap', value: '125' },
    { field: 'maxPostBalanceBase', value: '2' }, { field: 'maxPostBalanceQuote', value: '5000' },
    { field: 'deadline', value: String(Math.floor(Date.now() / 1000) + 604800) },
  ];
  const selectedEdits = content.includes('tiny allocations') ? [{ field: 'allocationBase', value: '0.000000000000000001' }, { field: 'allocationQuote', value: '0.000001' }]
    : partial ? edits.filter(e => ['baseToken', 'quoteToken', 'maxAmountBasePerSwap'].includes(e.field)) : edits;
  const title = content.match(/template-acceptance-[a-z0-9]+/)?.[0];
  if (title) selectedEdits.push({ field: 'title', value: title });
  let step = 0;
  return new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ async start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] }); await delay(120);
    if (step === 0) c.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'inspectStrategy', input: JSON.stringify({ view: 'current' }) });
    else if (step === 1 && !slow) c.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'createOrPatchDraft', input: JSON.stringify({
      expectedRevision: draft.revision, operation: 'patch', restoreRevision: null, edits: selectedEdits, requirements: [],
    }) });
    else {
      c.enqueue({ type: 'text-start', id: 'reply' });
      const text = slow ? 'I am comparing strategy risks and limits without changing any settings.'.repeat(20)
        : partial ? 'Saved the WETH per-swap limit of 0.05. Other limits are not set.'
        : `Saved strategy parameters.\n\n- Fixed range: **2200–${narrow ? '2700' : '2800'} USDC/WETH**\n- Per-swap limits: 0.05 WETH / 125 USDC\n- Post-swap inventory: 2 WETH / 5000 USDC\n\nThis remains an unpublished draft.`;
      for (let i = 0; i < text.length; i += 10) { c.enqueue({ type: 'text-delta', id: 'reply', delta: text.slice(i, i + 10) }); await delay(slow ? 80 : 30); }
      c.enqueue({ type: 'text-end', id: 'reply' });
    }
    const tool = step === 0 || (step === 1 && !slow); step++;
    c.enqueue({ type: 'finish', finishReason: { unified: tool ? 'tool-calls' : 'stop', raw: undefined }, usage }); c.close();
  } }) }) });
}
const worker = (async () => {
  while (!shutdown.signal.aborted) {
    const turn = await turns.claim();
    if (!turn) { await delay(100); continue; }
    const draft = await store.get(turn.owner, turn.draftId), messages = await store.messages(turn.owner, turn.conversationId);
    await runDesignTurn(pool, profile, fixtureModel(draft, messages.at(-1).content), turn, shutdown.signal);
  }
})();
const simulationWorker = (async () => {
  const simulations = createSimulations(pool, profile);
  while (!shutdown.signal.aborted) {
    const claim = await simulations.claim();
    if (!claim) { await delay(100); continue; }
    await runSimulation(pool, profile, fixtureSimulation, claim, shutdown.signal);
  }
})();
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; shutdown.abort();
  server.closeAllConnections(); server.close(); await Promise.all([worker, simulationWorker]);
  await pool.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
}
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
