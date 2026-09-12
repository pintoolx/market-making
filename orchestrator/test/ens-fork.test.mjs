import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, toBytes, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { namehash } from 'viem/ens';
import { ensTransactions } from '../../shared/ens/transactions.mjs';
import { createEnsReader, resolverAbi, registryAbi, deployments, matchingRegistrarCode } from '../../shared/ens/chain.mjs';
import { RELEASE_KEY, releasePointer, manifestMessage } from '../../shared/ens/schema.mjs';
import { publicationMessage } from '../../shared/lp-release.mjs';
import { makeServer } from '../src/server.mjs';
import { createEnsPublisher } from '../src/ens-publisher.mjs';

const rpc = process.env.ENS_FORK_RPC_URL;
test('official ENSv2 Sepolia fork: registration, signed version discovery, delegated publication, forbidden writes and revocation', { skip: !rpc, timeout: 240_000 }, async t => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(rpc).hostname), 'Only a local Anvil fork may receive test mutations.');
  const client = createPublicClient({ chain: sepolia, transport: http(rpc), cacheTime: 0, pollingInterval: 1000 });
  assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
  const snapshot = await client.request({ method: 'evm_snapshot' });
  t.after(() => client.request({ method: 'evm_revert', params: [snapshot] }));
  const previous = await client.getBlock();
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(Math.floor(Date.now() / 1000), Number(previous.timestamp) + 1)] });
  await client.request({ method: 'evm_mine' });
  const identity = label => privateKeyToAccount(keccak256(toBytes(`PinTool ENS fork isolated ${label} 20260913`)));
  const owner = identity('owner'), provider = identity('provider'), delegate = identity('delegate');
  const wallets = [owner, provider, delegate].map(account => createWalletClient({ account, chain: sepolia, transport: http(rpc) }));
  for (const account of [owner, provider, delegate]) {
    assert.equal(await client.getCode({ address: account.address }), undefined, 'Use an undelegated test EOA that can receive ERC1155 names.');
    await client.request({ method: 'anvil_setBalance', params: [account.address, '0x56BC75E2D63100000'] });
  }
  const root = `pintool-test-${Date.now().toString(36)}.eth`;
  const receipts = [], progress = p => { if (p.hash) receipts.push(p.hash); if (p.title.startsWith('Confirmed:')) t.diagnostic(p.title); };
  const adminTx = ensTransactions(client, wallets[0], progress), providerTx = ensTransactions(client, wallets[1], progress), delegateTx = ensTransactions(client, wallets[2], progress);
  const plan = await adminTx.prepareRoot(root);
  await assert.rejects(adminTx.registerRoot(root, plan));
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(plan.readyAt + 1, Math.floor(Date.now() / 1000))] });
  await client.request({ method: 'evm_mine' });
  await adminTx.registerRoot(root, plan);
  const platform = await adminTx.enablePlatform(root, plan);
  assert.ok(matchingRegistrarCode(await client.getCode({ address: platform.registrar })));
  const claimed = await providerTx.claimProvider(root, 'alice');
  assert.equal(claimed.provider.name, `alice.${root}`);
  await assert.rejects(providerTx.claimProvider(root, 'second'), /revert/i);
  await assert.rejects(delegateTx.claimProvider(root, 'alice'), /revert/i);
  const name = await providerTx.registerStrategy(root, 'eth-usdc');
  const reader = createEnsReader({ rootName: root, client });
  const found = await reader.describeName(name);
  assert.equal(found.provider, provider.address.toLowerCase());
  assert.equal(await client.getEnsAddress({ name: claimed.provider.name }), provider.address);

  const dir = await mkdtemp(join(tmpdir(), 'ens-fork-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const server = makeServer({ stateDir: dir, ensRootName: root, ensRpcUrl: rpc, strategies: [], allowedOrigin: 'http://localhost:3200' }, {
    runner: async () => { throw new Error('ENS must not activate a Maker.'); },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const api = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(api + path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    const data = await response.json(); if (!response.ok) throw new Error(data.message); return data;
  };
  const approved = async version => {
    const r = { schema: 'pintool-lp-release-v1', id: `${provider.address.toLowerCase().slice(2)}-clmm`, version, provider: provider.address.toLowerCase(),
      name: `Fork strategy ${version}`, summary: 'Synthetic public integration fixture', state: 'published',
      execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700,
        maxAmount0PerSwap: '4000', maxAmount1PerSwap: '1000', maxPostBalance0: '100000', maxPostBalance1: '100000', ttlSec: 300 } };
    const envelope = { version: 1, ephemeralPublicKey: '11'.repeat(32), nonce: '22'.repeat(24), ciphertext: '33'.repeat(32) };
    const saved = await call('/v1/provider-strategies', { release: r, envelope, signature: await provider.signMessage({ message: publicationMessage(r, envelope) }) });
    await call('/v1/ens/manifests', { name, releaseId: r.id, version, publicationDigest: saved.digest,
      signature: await provider.signMessage({ message: manifestMessage(name, root, r, saved.digest) }) });
    return releasePointer(r, saved.digest);
  };
  const first = await approved(1);
  await providerTx.publishPointer(root, name, first);
  const resolved = await call(`/v1/ens/resolve?name=${name}`);
  assert.deepEqual(resolved.pointer, first);
  assert.equal(JSON.stringify(resolved).includes('ciphertext'), false);
  await assert.rejects(delegateTx.publishPointer(root, name, first), /revert/i);
  const granted = await providerTx.delegate(root, name, delegate.address, true);
  assert.equal(granted.allowed, true); assert.equal(granted.broaderAccess, false);
  const second = await approved(2);
  const publisher = createEnsPublisher({ rootName: root, names: [name], client, wallet: wallets[2], apiUrl: api, onProgress: progress });
  assert.equal((await publisher.tick())[0].status, 'published');
  assert.equal((await publisher.tick())[0].status, 'up-to-date');
  assert.deepEqual((await reader.resolve(name)).pointer, second);
  // Bypass estimation to obtain actual reverted transaction receipts for forbidden operations.
  for (const [functionName, args] of [['setAddr', [namehash(name), delegate.address]], ['setText', [namehash(name), 'description', 'unauthorized']]]) {
    const hash = await wallets[2].writeContract({ address: found.resolver, abi: resolverAbi, functionName, args, gas: 500_000n });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'reverted');
  }
  await providerTx.delegate(root, name, delegate.address, false);
  assert.equal((await reader.delegation(name, delegate.address)).allowed, false);
  const third = await approved(3);
  assert.equal((await publisher.tick())[0].status, 'permission-revoked');
  const rejected = await wallets[2].writeContract({ address: found.resolver, abi: resolverAbi, functionName: 'setText', args: [namehash(name), RELEASE_KEY, JSON.stringify(third)], gas: 500_000n });
  assert.equal((await client.waitForTransactionReceipt({ hash: rejected })).status, 'reverted');
  assert.equal((await reader.resolve(name)).pointer.version, 2);
  // An ancestor pointer change invalidates discoverability, even though the old resolver still has records.
  const changed = await wallets[0].writeContract({ address: deployments.contracts.ETHRegistry.address, abi: registryAbi, functionName: 'setSubregistry',
    args: [BigInt(keccak256(toBytes(root.split('.')[0]))), zeroAddress] });
  assert.equal((await client.waitForTransactionReceipt({ hash: changed })).status, 'success');
  assert.equal(await client.readContract({ address: deployments.contracts.ETHRegistry.address, abi: registryAbi, functionName: 'getSubregistry', args: [root.split('.')[0]] }), zeroAddress);
  await assert.rejects(reader.resolve(name), /missing/);
  assert.ok(receipts.length >= 14);
});
