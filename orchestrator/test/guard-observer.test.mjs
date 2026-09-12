import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, toBytes } from 'viem';
import { currentBlock, findAcceptedReport, readGuardReport, waitForAcceptedReport } from '../src/guard-observer.mjs';

const maker = '0x1111111111111111111111111111111111111111';
const guard = '0x2222222222222222222222222222222222222222';
const router = '0x3333333333333333333333333333333333333333';
const token0 = '0x4444444444444444444444444444444444444444';
const token1 = '0x5555555555555555555555555555555555555555';
const strategyHash = `0x${'66'.repeat(32)}`;
const digest = `0x${'77'.repeat(32)}`;
const txHash = `0x${'88'.repeat(32)}`;
const abi = parseAbi(['function getReport(address,bytes32) view returns ((uint16,uint256,address,address,address,bytes32,address,address,uint64,uint48,uint48,uint8,uint128,uint128,uint128,uint128),bytes32)']);
const report = [1, 11155111n, guard, router, maker, strategyHash, token0, token1, 9n, 100n, 200n, 3, 10n, 20n, 30n, 40n];

const acceptedLog = { address: guard, transactionHash: txHash, blockNumber: '0x2b',
  topics: [keccak256(toBytes('ReportAccepted(address,bytes32,uint64,bytes32,uint48)')), `0x${maker.slice(2).padStart(64, '0')}`, strategyHash],
  data: encodeAbiParameters([{type:'uint64'}, {type:'bytes32'}, {type:'uint48'}], [9n, digest, 200]) };

function response(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

test('reads the current block and filters ReportAccepted by Guard, Maker and strategy', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'eth_blockNumber') return response('0x2a');
    return response([acceptedLog]);
  };
  assert.equal(await currentBlock('https://rpc.example', fetchImpl), 42n);
  assert.deepEqual(await findAcceptedReport({ rpcUrl: 'https://rpc.example', guard, maker, strategyHash, fromBlock: 42n }, fetchImpl),
    { transactionHash: txHash, blockNumber: 43n, nonce: 9n, digest });
  assert.deepEqual(calls[1].params[0].topics, [
    keccak256(toBytes('ReportAccepted(address,bytes32,uint64,bytes32,uint48)')),
    `0x${maker.slice(2).padStart(64, '0')}`,
    strategyHash,
  ]);
});

test('reads and decodes the stored Guard report', async () => {
  const encoded = encodeFunctionResult({ abi, functionName: 'getReport', result: [report, digest] });
  const stored = await readGuardReport({ rpcUrl: 'https://rpc.example', guard, maker, strategyHash }, async () => response(encoded));
  assert.equal(stored.report.nonce, 9n);
  assert.equal(stored.report.allowedDirections, 3);
  assert.equal(stored.digest, digest);
});

test('waits for an event before accepting matching stored evidence', async () => {
  const encoded = encodeFunctionResult({ abi, functionName: 'getReport', result: [report, digest] });
  let logCalls = 0;
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === 'eth_getLogs') return response(++logCalls === 1 ? [] : [acceptedLog]);
    if (method === 'eth_call') { assert.equal(params[1], '0x2b'); return response(encoded); }
    throw new Error('unexpected method');
  };
  const accepted = await waitForAcceptedReport({ rpcUrl: 'https://rpc.example', guard, maker, strategyHash, fromBlock: 42n },
    { fetchImpl, timeoutMs: 1000, intervalMs: 0, wait: async () => {} });
  assert.equal(accepted.transactionHash, txHash);
  assert.equal(accepted.report.validUntil, 200);
  assert.equal(logCalls, 2);
});

test('a later report cannot be attached to an earlier transaction', async () => {
  const encoded = encodeFunctionResult({ abi, functionName: 'getReport', result: [[...report.slice(0, 8), 10n, ...report.slice(9)], digest] });
  const fetchImpl = async (_url, init) => response(JSON.parse(init.body).method === 'eth_getLogs' ? [acceptedLog] : encoded);
  await assert.rejects(waitForAcceptedReport({ rpcUrl: 'https://rpc.example', guard, maker, strategyHash, fromBlock: 42n }, { fetchImpl, timeoutMs: 1000 }), /does not match/);
});
