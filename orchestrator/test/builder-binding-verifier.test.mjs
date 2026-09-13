import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, toBytes } from 'viem';
import { createRpcBindingVerifier } from '../src/builder-binding-verifier.mjs';

const maker = '0x1111111111111111111111111111111111111111';
const guard = '0x2222222222222222222222222222222222222222';
const router = '0x3333333333333333333333333333333333333333';
const token0 = '0x4444444444444444444444444444444444444444';
const token1 = '0x5555555555555555555555555555555555555555';
const strategyHash = `0x${'66'.repeat(32)}`;
const digest = `0x${'77'.repeat(32)}`;
const txHash = `0x${'88'.repeat(32)}`;
const guardAbi = parseAbi(['function getReport(address,bytes32) view returns ((uint16,uint256,address,address,address,bytes32,address,address,uint64,uint48,uint48,uint8,uint128,uint128,uint128,uint128),bytes32)']);
const profile = { chainId: 11155111, guard, router, tokens: [{ address: token0 }, { address: token1 }] };
const artifact = { payload: { strategyHash } };

function response(result) { return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); }
function fakeFetch(report = [2, 11155111n, guard, router, maker, strategyHash, token0, token1, 9n, 100n, 0n, 3, 10n, 20n, 30n, 40n]) {
  const encoded = encodeFunctionResult({ abi: guardAbi, functionName: 'getReport', result: [report, digest] });
  const log = { address: guard, transactionHash: txHash, blockNumber: '0x2b',
    topics: [keccak256(toBytes('ReportAccepted(address,bytes32,uint64,bytes32,uint48)')), `0x${maker.slice(2).padStart(64, '0')}`, strategyHash],
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'uint48' }], [9n, digest, 0]) };
  let calls = 0;
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'eth_getLogs') return response([log]);
    calls += 1;
    return response(calls === 1 ? encodeAbiParameters([{ type: 'uint256' }], [43n]) : encoded);
  };
}

test('RPC binding verifier accepts the exact standing report domain and receipt', async () => {
  const verify = createRpcBindingVerifier('https://rpc.example', { fetchImpl: fakeFetch() });
  const proof = await verify({ owner: `wallet:${maker}`, profile, artifact, reportDigest: digest, reportTransactionHash: txHash, reportNonce: '9' });
  assert.deepEqual(proof, { chainId: 11155111, maker, guard, router, strategyHash, reportSchema: 2, reportDigest: digest, reportTransactionHash: txHash, reportNonce: '9', accepted: true });
});

test('RPC binding verifier rejects wrong schema, receipt identity and provider failures', async () => {
  await assert.rejects(createRpcBindingVerifier('https://rpc.example', { fetchImpl: fakeFetch([1, 11155111n, guard, router, maker, strategyHash, token0, token1, 9n, 100n, 200n, 3, 10n, 20n, 30n, 40n]) })({ owner: `wallet:${maker}`, profile, artifact, reportDigest: digest, reportTransactionHash: txHash, reportNonce: '9' }), /binding-proof-mismatch/);
  await assert.rejects(createRpcBindingVerifier('https://rpc.example', { fetchImpl: fakeFetch() })({ owner: `wallet:${maker}`, profile, artifact, reportDigest: digest, reportTransactionHash: `0x${'99'.repeat(32)}`, reportNonce: '9' }), /binding-proof-mismatch/);
  await assert.rejects(createRpcBindingVerifier('https://rpc.example', { fetchImpl: async () => { throw new Error('provider response contains private data'); } })({ owner: `wallet:${maker}`, profile, artifact, reportDigest: digest, reportTransactionHash: txHash, reportNonce: '9' }), /binding-proof-unavailable/);
});
