import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportSchema, builderTermsHash, encodeBuilderReport, parseBuilderCreOutput } from '../src/builder-cre-protocol.mjs';
import { createCreSimulator, CreNotStartedError } from '../src/builder-cre-simulator.mjs';
const fixture = JSON.parse(await readFile(new URL('../../docs/guard-report-v1/example.json', import.meta.url), 'utf8'));
const report = reportSchema.parse({ ...fixture.report, schemaVersion: '2', validUntil: '0' });
const payload = { requestId: 'fixture', maker: report.maker, strategyHash: report.strategyHash, builder: { phase: 'evaluate' } };
const result = { kind: 'builder-cre-result', schemaVersion: 1, requestId: 'fixture', evidenceMode: 'cre-local-simulation', termsHash: builderTermsHash(report), phase: 'evaluate', status: 'evaluated', report, observedAt: '2026-09-13T00:00:00.000Z' };

test('CLI public parser validates identity and rejects duplicate or contaminated output', () => {
  const line = `[USER LOG] ${JSON.stringify(result)}`;
  assert.deepEqual(parseBuilderCreOutput(line, payload), result);
  assert.throws(() => parseBuilderCreOutput(line + '\n' + line, payload), /result-count/);
  for (const patch of [{ requestId: 'someone-else' }, { report: { ...report, nonce: 'NaN' } }, { report: { ...report, privatePolicy: 'CANARY' } }, { termsHash: '0x' + 'b'.repeat(64) }])
    assert.throws(() => parseBuilderCreOutput(JSON.stringify({ ...result, ...patch }), payload), /builder-cre-/);
  assert.equal(builderTermsHash({ ...report, nonce: '18446744073709551615', validAfter: '0' }), builderTermsHash(report));
  assert.equal(encodeBuilderReport(report).payload.length, 1026);
});

test('CLI process fixes flags, bounds execution and cleans its own temporary input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'builder-cli-test-'));
  try {
    const executable = join(dir, 'cre-fixture');
    await writeFile(executable, '#!/usr/bin/env node\n' + `
      const fs = require('node:fs');
      const args = process.argv.slice(2), get = key => args[args.indexOf(key) + 1];
      if (get('--target') !== 'staging-settings' || get('--trigger-index') !== '1' || !args.includes('--non-interactive') || args.includes('--broadcast')) process.exit(3);
      fs.writeFileSync(${JSON.stringify(join(dir, 'paths.json'))}, JSON.stringify([get('--config'), get('--http-payload')]));
      console.log('[USER LOG] ' + ${JSON.stringify(JSON.stringify(result))});
    `, { mode: 0o700 });
    const simulate = createCreSimulator({ projectDirectory: dir, executable, broadcastEnabled: false });
    const config = { builderSimulation: true, maker: report.maker, strategyHash: report.strategyHash, publishMode: 'dry-run' };
    assert.deepEqual(await simulate({ config, payload }), result);
    for (const path of JSON.parse(await readFile(join(dir, 'paths.json'), 'utf8'))) await assert.rejects(readFile(path), { code: 'ENOENT' });
    await assert.rejects(simulate({ config, payload: { ...payload, builder: { phase: 'deliver' } } }), CreNotStartedError);
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stderr.write("PRIVATE_CANARY"); process.exit(1);', { mode: 0o700 });
    await assert.rejects(simulate({ config, payload }), error => error.message === 'builder-cre-execution-failed');
    await writeFile(executable, '#!/usr/bin/env node\nsetInterval(()=>{}, 1000);', { mode: 0o700 });
    await assert.rejects(createCreSimulator({ projectDirectory: dir, executable, timeoutMs: 1000 })({ config, payload }), /builder-cre-timeout/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only receipt verification uses an exact event and canonical receipt despite later reports', async () => {
  const { createBuilderCreChain, builderGuardAbi } = await import('../src/builder-cre-chain.mjs');
  const { encodeEventTopics, encodeAbiParameters } = await import('viem');
  const profile = { chainId: Number(report.chainId), guard: report.guard, router: report.router, tokens: [{ address: report.token0 }, { address: report.token1 }] };
  const encoded = encodeBuilderReport(report), blockHash = '0x' + '1'.repeat(64), txHash = '0x' + '2'.repeat(64);
  const topics = encodeEventTopics({ abi: builderGuardAbi, eventName: 'ReportAccepted', args: { maker: report.maker, strategyHash: report.strategyHash } });
  const data = encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'uint48' }], [BigInt(report.nonce), encoded.digest, 0n]);
  const log = { address: report.guard, topics, data, transactionHash: txHash, blockNumber: 100n, blockHash, logIndex: 2,
    args: { maker: report.maker, strategyHash: report.strategyHash, nonce: BigInt(report.nonce), digest: encoded.digest } };
  let currentHash = blockHash, receiptStatus = 'success', includeLog = true;
  const later = encodeBuilderReport({ ...report, nonce: String(BigInt(report.nonce) + 1n) });
  const client = {
    getChainId: async () => profile.chainId, getBlockNumber: async () => 102n,
    getBlock: async () => ({ hash: currentHash }), getLogs: async () => [log],
    getTransactionReceipt: async () => ({ status: receiptStatus, blockNumber: 100n, blockHash, logs: includeLog ? [log] : [] }),
    readContract: async () => [later.report, later.digest],
  };
  const chain = createBuilderCreChain(profile, { client });
  assert.equal((await chain.accepted({ report, fromBlock: '90' })).receipt.readback, 'superseded-in-same-block');
  includeLog = false;
  assert.equal(await chain.accepted({ report, fromBlock: '90' }), null);
  includeLog = true; currentHash = '0x' + '3'.repeat(64);
  assert.equal(await chain.accepted({ report, fromBlock: '90', transactionHash: txHash }), null);
  currentHash = blockHash; receiptStatus = 'reverted';
  assert.equal((await chain.accepted({ report, fromBlock: '90', transactionHash: txHash })).status, 'reverted');
});
