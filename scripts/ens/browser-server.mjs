import { createPublicClient, createWalletClient, http, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../../orchestrator/src/server.mjs';
import { createProviderRegistry } from '../../orchestrator/src/provider-registry.mjs';
import { publicationMessage } from '../../shared/lp-release.mjs';
import { ensTransactions } from '../../shared/ens/transactions.mjs';

const rpc = 'http://127.0.0.1:18546', client = createPublicClient({ chain: sepolia, transport: http(rpc), cacheTime: 0 });
if (!(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('Browser fixtures require local Anvil.');
const mineFresh = async () => {
  const block = await client.getBlock();
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(Math.floor(Date.now() / 1000), Number(block.timestamp) + 1)] });
  await client.request({ method: 'evm_mine' });
};
await mineFresh();
const admin = privateKeyToAccount(keccak256(toBytes('PinTool ENSv2 public test owner 2026-09-13')));
await client.request({ method: 'anvil_setBalance', params: [admin.address, '0x56BC75E2D63100000'] });
const setup = ensTransactions(client, createWalletClient({ account: admin, chain: sepolia, transport: http(rpc) }), p => console.log(p.title));
const plan = await setup.prepareRoot('pintool.eth');
if (!plan.registered) {
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(plan.readyAt + 1, Math.floor(Date.now() / 1000))] });
  await client.request({ method: 'evm_mine' });
  await setup.registerRoot('pintool.eth', plan);
}
await setup.enablePlatform('pintool.eth', plan);
const provider = privateKeyToAccount(keccak256(toBytes('PinTool ENS browser public provider 20260913')));
const delegate = privateKeyToAccount(keccak256(toBytes('PinTool ENS browser public delegate 20260913')));
for (const a of [provider, delegate]) await client.request({ method: 'anvil_setBalance', params: [a.address, '0x56BC75E2D63100000'] });
const dir = await mkdtemp(join(tmpdir(), 'ens-browser-api-'));
const registry = createProviderRegistry(dir);
async function publish(version) {
  const release = { schema: 'pintool-lp-release-v1', id: `${provider.address.toLowerCase().slice(2)}-clmm`, version, provider: provider.address.toLowerCase(), name: `Browser range v${version}`, summary: 'Public synthetic browser test strategy', state: 'published',
    execution: { curve: 'concentrated', chainId: 11155111, pair: 'WETH/USDC', feeBps: 0, rangeBelowBps: 300, rangeAboveBps: 700, maxAmount0PerSwap: '4000', maxAmount1PerSwap: '1000', maxPostBalance0: '100000', maxPostBalance1: '100000', ttlSec: 300 } };
  const envelope = { version: 1, ephemeralPublicKey: '11'.repeat(32), nonce: '22'.repeat(24), ciphertext: '33'.repeat(32) };
  await registry.publish({ release, envelope, signature: await provider.signMessage({ message: publicationMessage(release, envelope) }) });
}
await publish(1);
const server = makeServer({ stateDir: dir, ensRootName: 'pintool.eth', ensRpcUrl: rpc, strategies: [], allowedOrigin: 'http://127.0.0.1:13201' }, { runner: async () => { throw new Error('Browser ENS test must not run CRE.'); } });
server.listen(18788, '127.0.0.1', () => console.log(`ENS browser fixture API on 18788; PID ${process.pid}`));
// Keep only the local fork clock fresh while the browser reads; no public-chain writes.
const tick = setInterval(async () => { try { await mineFresh(); } catch {} }, 10_000);
let version = 1;
process.on('SIGUSR1', () => { void publish(++version).then(() => console.log(`Synthetic version ${version} saved`)); });
process.once('SIGTERM', () => { clearInterval(tick); server.close(); });
