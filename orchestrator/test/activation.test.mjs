import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, keccak256 } from 'viem';
import { createActivationService } from '../src/activation-service.mjs';
import { activationCatalog, activationStore, syncActivationBindings } from '../src/activation-store.mjs';
import { aquaActivationAbi } from '../../shared/aqua-activation.mjs';

const maker = `0x${'11'.repeat(20)}`, aqua = `0x${'22'.repeat(20)}`, router = `0x${'33'.repeat(20)}`, guard = `0x${'44'.repeat(20)}`;
const tokens = [`0x${'55'.repeat(20)}`, `0x${'66'.repeat(20)}`];
const hash = `0x${'77'.repeat(32)}`, blockHash = `0x${'88'.repeat(32)}`, digest = `0x${'99'.repeat(32)}`;
const id = '00000000-0000-4000-8000-000000000001', releaseId = `${maker.slice(2)}-clmm`;
const amounts = ['100', '200'];

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'maker-activation-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const publication = { release: { id: releaseId, version: 1, state: 'published' }, digest, envelope: { ciphertext: 'private-ciphertext' } };
  const plan = { release: { id: releaseId, version: 1, digest }, strategy: '0x1234', strategyHash: keccak256('0x1234'),
    request: { strategy: { maker, tokens } }, deployment: { aqua, router, guard: { address: guard } },
    catalogEntry: { name: 'Published range', provider: maker, release: { id: releaseId, version: 1, digest }, programDeadline: 9999999999 },
    workflowBinding: { strategyHash: keccak256('0x1234'), provider: maker, strategyId: `${releaseId}.v1`, envelopeHash: digest } };
  plan.catalogEntry.strategyHash = plan.strategyHash;
  const transaction = { from: maker, to: aqua, input: encodeFunctionData({ abi: aquaActivationAbi, functionName: 'ship', args: [router, plan.strategy, tokens, amounts.map(BigInt)] }), value: 0n, blockHash };
  const receipt = { status: 'success', blockHash, blockNumber: 100n };
  let funds = 1000n, count = 2, chainId = 11155111, synced = 0;
  const service = createActivationService({ stateDir, chainId: 11155111, strategyMaker: maker, aqua, router, guard, rpcUrl: 'http://unused' }, {
    read: async () => publication, latest: async () => publication,
  }, {
    compileActivation: async input => { assert.equal(input.publication.digest, digest); return structuredClone(plan); },
    syncActivationBindings: async () => { synced++; },
    activationClient: { getChainId: async () => chainId, getBlockNumber: async () => 102n,
      getTransaction: async () => transaction, getTransactionReceipt: async () => receipt,
      readContract: async ({ functionName, args }) => functionName === 'rawBalances' ? [BigInt(amounts[tokens.indexOf(args[3])]), count] : funds },
  });
  const input = { id, maker, releaseId, version: 1, amounts };
  return { service, stateDir, input, plan, receipt, transaction, publication, get synced() { return synced; }, set funds(v) { funds = v; }, set count(v) { count = v; }, set chainId(v) { chainId = v; } };
}

test('preparation is unsigned and idempotent; only a matching onchain ship becomes executable, with restart recovery', async t => {
  const f = await fixture(t);
  const prepared = await f.service.prepare(f.input);
  assert.equal(prepared.transactionHash, null);
  assert.equal(JSON.stringify(prepared).includes('private-ciphertext'), false);
  assert.deepEqual(await activationCatalog(f.stateDir), {});
  assert.deepEqual(await f.service.prepare(f.input), prepared);
  await assert.rejects(f.service.prepare({ ...f.input, amounts: ['2', '3'] }), /inputs changed/);
  const confirmed = await f.service.confirm(id, { transactionHash: hash });
  assert.equal(confirmed.transactionHash, hash);
  assert.equal(f.synced, 1);
  assert.equal((await activationCatalog(f.stateDir))[`${releaseId}.v1`].strategyHash, f.plan.strategyHash);
  assert.equal((await activationStore(f.stateDir).read(id)).transactionHash, hash);
  assert.equal((await activationCatalog(f.stateDir))[`${releaseId}.v1`].shipTransaction, hash);
  assert.equal((await f.service.confirm(id, { transactionHash: hash })).transactionHash, hash);
  await assert.rejects(f.service.prepare({ ...f.input, id: id.replace(/1$/, '2') }), /already enabled/);
});

test('wrong wallet, calldata, target, reverted receipt, wrong chain, missing funding and docked state cannot activate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare({ ...f.input, maker: tokens[0] }), /connected Maker/);
  await f.service.prepare(f.input);
  for (const [key, value] of [['from', tokens[0]], ['to', router], ['input', '0x'], ['value', 1n], ['blockHash', hash]]) {
    const saved = f.transaction[key]; f.transaction[key] = value;
    await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /does not confirm/);
    f.transaction[key] = saved;
  }
  f.receipt.status = 'reverted';
  await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /does not confirm/);
  f.receipt.status = 'success'; f.chainId = 1;
  await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /Sepolia/);
  f.chainId = 11155111; f.funds = 0n;
  await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /sufficient/);
  f.funds = 1000n; f.count = 255;
  await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /register/);
  assert.deepEqual(await activationCatalog(f.stateDir), {});
});

test('withdrawal after preparation prevents activation and binding restoration does not replace existing providers', async t => {
  const f = await fixture(t);
  await f.service.prepare(f.input);
  f.publication.release.state = 'withdrawn';
  await assert.rejects(f.service.confirm(id, { transactionHash: hash }), /withdrawn/);
  f.publication.release.state = 'published';
  await f.service.confirm(id, { transactionHash: hash });
  const path = join(f.stateDir, 'config.json'), other = { strategyHash: hash, provider: maker };
  await writeFile(path, JSON.stringify({ marketSource: 'kraken', providerBindings: [other] }));
  await syncActivationBindings(f.stateDir, path);
  const restored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(restored.marketSource, 'kraken'); assert.deepEqual(restored.providerBindings, [other, f.plan.workflowBinding]);
  await syncActivationBindings(f.stateDir, path);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).providerBindings.length, 2);
});
