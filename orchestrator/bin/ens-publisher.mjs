#!/usr/bin/env node
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createEnsPublisher } from '../src/ens-publisher.mjs';

// Dedicated publisher credentials supplied by the operator. Never use a Maker or Provider owner key.
const key = process.env.ENS_PUBLISHER_PRIVATE_KEY;
if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('Configure a dedicated ENS_PUBLISHER_PRIVATE_KEY.');
const rootName = process.env.ENS_ROOT_NAME ?? 'pintool.eth';
const rpc = process.env.ENS_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const account = privateKeyToAccount(key);
const client = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 15_000 }) });
const wallet = createWalletClient({ chain: sepolia, account, transport: http(rpc) });
const publisher = createEnsPublisher({ rootName, names: (process.env.ENS_PUBLISHER_NAMES ?? '').split(',').map(n => n.trim()).filter(Boolean),
  apiUrl: process.env.ENS_PUBLISHER_API_URL ?? 'http://127.0.0.1:8787', client, wallet,
  onProgress: p => { if (p.hash) console.log(JSON.stringify({ event: 'transaction', hash: p.hash })); } });
const interval = Number(process.env.ENS_PUBLISHER_INTERVAL_MS ?? 60_000);
if (!Number.isSafeInteger(interval) || interval < 30_000) throw new Error('Publisher interval must be at least 30 seconds.');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
console.log(JSON.stringify({ event: 'started', publisher: account.address, rootName, chainId: sepolia.id }));
do {
  console.log(JSON.stringify({ event: 'checked', results: await publisher.tick() }));
  if (process.argv.includes('--once') || stop.signal.aborted) break;
  await new Promise(resolve => { const finish = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, interval); stop.signal.addEventListener('abort', finish, { once: true }); });
} while (!stop.signal.aborted);
