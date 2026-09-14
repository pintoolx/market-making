// Explicit local Sepolia fork acceptance. No public-chain writes or user keys.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder';
import { startBuilderFork } from '../../../../contracts/aqua-executor/src/builder-fork.ts';
import { aquaAbi, routerAbi } from '../../../../contracts/aqua-executor/src/abi.ts';
import { takerTraits } from '../../../../contracts/aqua-executor/src/compile.ts';
import { buildGuardReportTx } from '../../../../contracts/aqua-executor/src/guard.ts';
import { createStore, createArtifacts, createSimulations, runSimulation, forkSimulationAdapter } from '../../src/index.ts';
import { createWalletChain } from '../../src/wallet-chain.ts';

export async function createWalletFixture(pool) {
  const maker = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80').address.toLowerCase();
  const owner = `wallet:${maker}`, options = { rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', anvil: process.env.ANVIL || 'anvil' };
  const store = createStore(pool, profile.id), created = await store.create(owner, randomUUID(), { kind: 'maker', title: 'Wallet fork acceptance' });
  const { draft } = await store.patch(owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: {
    spec: { baseToken: profile.tokens[0], quoteToken: profile.tokens[1], model: { kind: 'xyc' }, feeBps: 0,
      deadline: Math.floor(Date.now() / 1000) + 3600, guardEnvelope: { maxAmountBasePerSwap: '100000000000000', maxAmountQuotePerSwap: '250000', maxPostBalanceBase: '2000000000000000', maxPostBalanceQuote: '5000000' } },
    allocations: { baseAtomic: '1000000000000000', quoteAtomic: '2500000' },
  } });
  const artifacts = createArtifacts(pool, profile), artifact = await artifacts.compile(owner, randomUUID(), { draftId: draft.id, expectedRevision: draft.revision });
  const compilation = (await artifacts.get(owner, artifact.artifactId)).payload, simulations = createSimulations(pool, profile);
  await simulations.start(owner, randomUUID(), { draftId: draft.id, expectedRevision: draft.revision, artifactId: artifact.artifactId });
  const claim = await simulations.claim();
  await runSimulation(pool, profile, forkSimulationAdapter(profile, options), claim);
  const simulation = await simulations.get(owner, claim.id);
  assert.equal(simulation.report?.passed, true, JSON.stringify(simulation));
  assert.equal(simulation.report?.coverageComplete, true);
  const fork = await startBuilderFork(profile, options), rpcUrl = fork.pc.transport.url;
  assert.equal(new URL(rpcUrl).hostname, '127.0.0.1');
  const evidence = { mode: 'browser-api-postgres-and-sepolia-fork', publicChainWrites: 0, fixtureWallet: maker,
    fork: fork.evidence, simulation: simulation.report, strategyHash: compilation.strategyHash, cases: [] };
  try {
    // This public test account may have EIP-7702 code on Sepolia. The browser
    // fixture is a local EOA; override only our owned fork and disclose it.
    await fork.dev('anvil_setCode', [maker, '0x']);
    evidence.localAccountCodeOverride = true;
    await fork.fund(maker, profile.tokens.map((t, i) => ({ token: t.address, amount: i === 0 ? '10000000000000000' : '25000000' })));
    await fork.fund(fork.taker, profile.tokens.map((t, i) => ({ token: t.address, amount: i === 0 ? '1000000000000000' : '2500000' })));
    await fork.impersonate(profile.forwarder);
    for (const token of profile.tokens) await fork.receipt(await fork.wallet(fork.taker).writeContract({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [profile.router, 2n ** 128n] }));
    const chain = createWalletChain(profile, { client: fork.pc, confirmations: 1 });
    const fresh = async () => { await fork.dev('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]); await fork.dev('evm_mine', []); };
    const walletChain = Object.fromEntries(['preflight','reconcile','unused'].map(method => [method, async (...args) => {
      await fresh(); const result = await chain[method](...args);
      if (result?.evidence) result.evidence.mode = 'fork-with-overrides';
      return result;
    }]));
    const balances = async () => ({ maker: await Promise.all(profile.tokens.map(t => fork.pc.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [maker] }).then(String))),
      aqua: await Promise.all(profile.tokens.map(t => fork.pc.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [maker, profile.router, compilation.strategyHash, t.address] }).then(v => v.map(String)))) });
    let nonce = 1n;
    return { rpcUrl, walletChain, stop: fork.stop, async action(kind) {
      await fresh();
      if (kind === 'allow' || kind === 'pause') {
        const caps = compilation.params.guard.caps;
        const report = { schemaVersion: 2, chainId: BigInt(profile.chainId), guard: profile.guard, router: profile.router, maker,
          strategyHash: compilation.strategyHash, token0: profile.tokens[0].address, token1: profile.tokens[1].address, nonce: nonce++,
          validAfter: Number((await fork.pc.getBlock()).timestamp), validUntil: 0, allowedDirections: kind === 'allow' ? 3 : 0,
          ...Object.fromEntries(Object.entries(caps).map(([k,v]) => [k, kind === 'allow' ? BigInt(v) : 0n])) };
        const receipt = await fork.receipt(await fork.wallet(profile.forwarder).sendTransaction({ ...buildGuardReportTx(profile.guard, '0x', report), gas: 5000000n }));
        evidence.cases.push({ kind, authority: 'synthetic-forwarder-impersonation', hash: receipt.transactionHash });
      } else if (kind === 'trade' || kind === 'blocked') {
        const order = { ...compilation.order, traits: BigInt(compilation.order.traits) }, args = [order, profile.tokens[1].address, profile.tokens[0].address, 100000n, takerTraits(0n)];
        const before = await balances();
        const hash = await fork.wallet(fork.taker).sendTransaction({ to: profile.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swap', args }), gas: 5000000n });
        const receipt = await fork.waitForReceipt(hash), after = await balances();
        assert.equal(receipt.status, kind === 'trade' ? 'success' : 'reverted');
        if (kind === 'blocked') assert.deepEqual(after, before);
        else { assert.equal(BigInt(after.maker[1]) - BigInt(before.maker[1]), 100000n); assert.ok(BigInt(after.maker[0]) < BigInt(before.maker[0])); }
        evidence.cases.push({ kind, hash, before, after });
      } else if (kind === 'evidence') {
        const executions = (await pool.query('SELECT state,transaction_hash,nonce::text,evidence FROM builder.wallet_executions WHERE owner=$1 ORDER BY created_at', [owner])).rows;
        evidence.executions = executions; evidence.finalBalances = await balances();
        await writeFile('.cache/builder/wallet-fork-browser.json', JSON.stringify(evidence, null, 2) + '\n');
      } else throw new Error('Unknown fixture action');
      return { ok: true, cases: evidence.cases.length };
    } };
  } catch (e) { await fork.stop(); throw e; }
}
