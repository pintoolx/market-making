import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { namehash } from 'viem/ens';
import { normalizeRoot, strategyName, parseReleasePointer, releasePointer, manifestMessage, publicReleaseHash } from '../../shared/ens/schema.mjs';
import { createEnsService } from '../src/ens-service.mjs';
import { createProviderRegistry } from '../src/provider-registry.mjs';
import { createService } from '../src/service.mjs';
import { makeServer } from '../src/server.mjs';
import { publicationMessage } from '../../shared/lp-release.mjs';

// Public test identities and synthetic ciphertext only.
const owner = privateKeyToAccount(keccak256(toBytes('PinTool ENS service test owner')));
const stranger = privateKeyToAccount(keccak256(toBytes('PinTool ENS service test stranger')));
const provider = owner.address.toLowerCase(), root = 'pintool.eth', name = 'eth-usdc.alice.pintool.eth';
const hash = c => '0x' + c.repeat(64);
const envelope = { version: 1, ephemeralPublicKey: '11'.repeat(32), nonce: '22'.repeat(24), ciphertext: '33'.repeat(32) };
const release = (version = 1, state = 'published') => ({ schema: 'pintool-lp-release-v1', id: `${provider.slice(2)}-clmm`, version, provider,
  name: `Strategy ${version}`, summary: 'Public synthetic strategy', state,
  execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700,
    maxAmount0PerSwap: '4000', maxAmount1PerSwap: '1000', maxPostBalance0: '100000', maxPostBalance1: '100000', ttlSec: 300 } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pintool-ens-')); t.after(() => rm(dir, { force: true, recursive: true }));
  const registry = createProviderRegistry(dir), config = { stateDir: dir, strategies: [], strategyMaker: stranger.address, ensRootName: root };
  let pointer, currentProvider = provider;
  const reader = {
    describeName: async n => ({ name: n, provider: currentProvider }),
    resolve: async n => ({ name: n, node: namehash(n), provider: currentProvider, pointer, blockNumber: '123', blockHash: hash('f') }),
  };
  const ens = createEnsService(config, registry, { ensReader: reader });
  async function publish(version = 1, state = 'published') {
    const r = release(version, state), signature = await owner.signMessage({ message: publicationMessage(r, envelope) });
    const saved = await registry.publish({ release: r, envelope, signature });
    const input = { name, releaseId: r.id, version, publicationDigest: saved.digest,
      signature: await owner.signMessage({ message: manifestMessage(name, root, r, saved.digest) }) };
    return { saved, input };
  }
  return { dir, config, registry, reader, ens, publish, setPointer: p => { pointer = p; }, setOwner: p => { currentProvider = p; } };
}

test('ENS names and references are normalized, scoped, chain-bound and version-bound', () => {
  assert.equal(normalizeRoot(' PINTOOL.eth '), root);
  assert.equal(strategyName('ETH-USDC.ALICE.PINTOOL.eth', root), name);
  for (const n of ['alice.pintool.eth', 'eth-usdc.alice.evil.eth', 'a.alice.pintool.eth', 'eth-usdc.alice.pintool.eth.evil']) assert.throws(() => strategyName(n, root));
  const p = releasePointer(release(), hash('a'));
  for (const changed of [{ chainId: 1 }, { version: 0 }, { provider: stranger.address }, { url: 'http://localhost/private' }, { releaseId: '../escape' }]) assert.throws(() => parseReleasePointer({ ...p, ...changed }));
  assert.equal(publicReleaseHash({ ...release(), digest: hash('a'), executionStatus: 'requires-provisioning' }), publicReleaseHash(release()));
});

test('public manifest verifies original publication and namespace ownership without exposing ciphertext', async t => {
  const f = await fixture(t), { saved, input } = await f.publish();
  const approved = await f.ens.saveManifest(input);
  assert.equal(approved.pointer.publicationDigest, saved.digest);
  assert.equal(JSON.stringify(approved).includes('ciphertext'), false);
  assert.equal(JSON.stringify(approved).includes(envelope.ciphertext), false);
  f.setPointer(approved.pointer);
  assert.equal((await f.ens.resolve(name)).manifest.release.name, 'Strategy 1');
  const restarted = createEnsService(f.config, f.registry, { ensReader: f.reader });
  assert.deepEqual(await restarted.saveManifest(input), approved);
  assert.equal((await restarted.approvedManifest(name, saved.id, 1)).signature, input.signature);
  await assert.rejects(restarted.saveManifest({ ...input, name: 'other.alice.pintool.eth' }), /Only the Provider/);
  f.setOwner(stranger.address);
  await assert.rejects(restarted.saveManifest(input), /does not own/);
});

test('withdrawal, missing approval, tampered storage and pointer substitution fail verification', async t => {
  const f = await fixture(t), { saved, input } = await f.publish();
  await f.ens.saveManifest(input); f.setPointer(releasePointer(saved, saved.digest));
  const next = await f.publish(2);
  await assert.rejects(f.ens.latestApproved(name), /ENOENT/);
  await f.ens.saveManifest(next.input);
  assert.equal((await f.ens.latestApproved(name)).pointer.version, 2);
  f.setPointer({ ...releasePointer(saved, saved.digest), publicationDigest: hash('0') });
  await assert.rejects(f.ens.resolve(name), /signature or digest/);
  f.setPointer(releasePointer(saved, saved.digest));
  const recordFile = join(f.dir, 'ens-manifests', `${namehash(name)}-${saved.digest}.json`);
  const tampered = JSON.parse(await readFile(recordFile, 'utf8')); tampered.release.name = 'Malicious replacement';
  await writeFile(recordFile, JSON.stringify(tampered));
  await assert.rejects(f.ens.resolve(name), /manifest is invalid/);
  await f.publish(3, 'withdrawn'); await f.publish(4);
  await assert.rejects(f.ens.approvedManifest(name, saved.id, 1), /withdrawn/);
});

test('Maker selection is rechecked before runner execution and remains pinned after later ENS changes', async t => {
  const f = await fixture(t), first = await f.publish();
  await f.ens.saveManifest(first.input); const pointer = releasePointer(first.saved, first.saved.digest); f.setPointer(pointer);
  const id = `${pointer.releaseId}.v1`, selection = { name, node: namehash(name), pointer };
  f.config.strategies.push({ id, release: { id: pointer.releaseId, version: 1, digest: pointer.publicationDigest } });
  const config = { ...f.config, chainId: 11155111, networkName: 'Ethereum Sepolia', explorerUrl: 'https://sepolia.etherscan.io' };
  const runnerInputs = [];
  const service = createService(config, { validateEnsSelections: (...args) => f.ens.validateSelections(...args),
    runner: async input => { runnerInputs.push(input); return {
      mandateId: 'ens-mandate', maker: stranger.address, regime: 'normal', ensSelections: [{ name: 'forged.eth' }],
      strategies: input.action === 'add-strategy' ? input.current.strategies.some(s => s.listingId === input.providerStrategyId) ? input.current.strategies
        : [...input.current.strategies, { ...input.current.strategies[0], listingId: input.providerStrategyId, status: 'standby' }]
        : input.current?.strategies ?? [{ listingId: id, name: 'Strategy 1', strategyHash: hash('b'), status: 'active', maxAmountPerSwapAtomic: '1000' }],
      evidence: { chainId: 11155111, networkName: 'Ethereum Sepolia', reportDigest: hash('c'), reportTransactionHash: hash('d'), reportExplorerUrl: `https://sepolia.etherscan.io/tx/${hash('d')}`, sequence: '1', expiresAt: new Date().toISOString() }, events: [],
    }; }, verifyReceipt: async () => ({ chainId: 11155111 }), readLpReadiness: async () => ({ phase: 'unverified', reasons: [] }) });
  const create = () => service.create({ maker: stranger.address, providerStrategyIds: [id], makerLimitsEnvelope: envelope, ensSelections: [selection] });
  const created = await create(); assert.equal(created.ensSelections[0].pointer.version, 1);
  assert.equal('ensSelections' in runnerInputs[0].input, false);
  const second = await f.publish(2); await f.ens.saveManifest(second.input); f.setPointer(releasePointer(second.saved, second.saved.digest));
  await assert.rejects(create(), /ENS strategy changed/);
  assert.equal(runnerInputs.length, 1);
  const resumed = await service.get('ens-mandate'); assert.equal(resumed.ensSelections[0].pointer.version, 1);
  assert.equal(runnerInputs.length, 1, 'A status refresh must not evaluate or broadcast a new report.');
  assert.equal(JSON.stringify(resumed).includes('forged.eth'), false);
  const persisted = JSON.parse(await readFile(join(f.dir, 'ens-mandate.json'), 'utf8'));
  assert.deepEqual(persisted.ensSelections, created.ensSelections);
  const reevaluated = await service.add('ens-mandate', { providerStrategyId: id });
  assert.deepEqual(reevaluated.ensSelections, created.ensSelections, 'Re-evaluating a standing mandate retains its ENS version after ENS advances.');
  assert.equal(runnerInputs.length, 2);
  await assert.rejects(f.ens.validateSelections([selection], ['different-id'], stranger.address), /differs/);
  const nextPointer = releasePointer(second.saved, second.saved.digest), nextId = `${nextPointer.releaseId}.v2`;
  const nextSelection = { name, node: namehash(name), pointer: nextPointer };
  f.config.strategies.push({ id: nextId, release: { id: nextPointer.releaseId, version: 2, digest: nextPointer.publicationDigest } });
  const expanded = await service.add('ens-mandate', { providerStrategyId: nextId, ensSelection: nextSelection });
  assert.deepEqual(expanded.ensSelections.map(s => s.pointer.version), [1, 2]);
  assert.deepEqual((await service.get('ens-mandate')).ensSelections, expanded.ensSelections);
  const calls = runnerInputs.length;
  await assert.rejects(service.add('ens-mandate', { providerStrategyId: nextId, ensSelection: nextSelection }), /already in/);
  assert.equal(runnerInputs.length, calls);
});

test('ENS HTTP endpoints share the publication store and reject unapproved public records', async t => {
  const f = await fixture(t), { saved, input } = await f.publish();
  f.setPointer(releasePointer(saved, saved.digest));
  const server = makeServer({ ...f.config, allowedOrigin: 'http://localhost:3200' }, { ensReader: f.reader, runner: async () => { throw new Error('ENS must not invoke CRE.'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1/ens`;
  assert.equal((await fetch(`${base}/resolve?name=${name}`)).status, 409);
  const response = await fetch(`${base}/manifests`, { method: 'POST', body: JSON.stringify(input) }); assert.equal(response.status, 200);
  const resolved = await (await fetch(`${base}/resolve?name=${name}`)).json(); assert.equal(resolved.pointer.version, 1);
  assert.equal(JSON.stringify(resolved).includes('ciphertext'), false);
  assert.equal((await fetch(`${base}/resolve?name=eth-usdc.alice.evil.eth`)).status, 409);
  assert.equal((await (await fetch(`${base}/names`)).json()).names[0].verified, true);
});
