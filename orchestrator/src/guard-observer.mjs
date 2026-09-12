import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toBytes } from 'viem';

const guardAbi = parseAbi([
  'event ReportAccepted(address indexed maker, bytes32 indexed strategyHash, uint64 nonce, bytes32 digest, uint48 validUntil)',
  'function getReport(address maker, bytes32 strategyHash) view returns ((uint16 schemaVersion,uint256 chainId,address guard,address router,address maker,bytes32 strategyHash,address token0,address token1,uint64 nonce,uint48 validAfter,uint48 validUntil,uint8 allowedDirections,uint128 maxAmount0PerSwap,uint128 maxAmount1PerSwap,uint128 maxPostBalance0,uint128 maxPostBalance1) report, bytes32 digest)',
]);
const REPORT_ACCEPTED_TOPIC = keccak256(toBytes('ReportAccepted(address,bytes32,uint64,bytes32,uint48)'));
const addressTopic = address => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

async function rpc(rpcUrl, method, params, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC request failed (${response.status})`);
  const payload = await response.json();
  if (payload?.error || payload?.result === undefined) throw new Error('RPC returned an error');
  return payload.result;
}

export async function currentBlock(rpcUrl, fetchImpl = fetch) {
  return BigInt(await rpc(rpcUrl, 'eth_blockNumber', [], fetchImpl));
}

export async function readGuardReport({ rpcUrl, guard, maker, strategyHash, blockNumber }, fetchImpl = fetch) {
  const data = encodeFunctionData({ abi: guardAbi, functionName: 'getReport', args: [maker, strategyHash] });
  const result = await rpc(rpcUrl, 'eth_call', [{ to: guard, data }, blockNumber === undefined ? 'latest' : `0x${blockNumber.toString(16)}`], fetchImpl);
  const [report, digest] = decodeFunctionResult({ abi: guardAbi, functionName: 'getReport', data: result });
  return { report, digest };
}

export async function findAcceptedReport({ rpcUrl, guard, maker, strategyHash, fromBlock }, fetchImpl = fetch) {
  const logs = await rpc(rpcUrl, 'eth_getLogs', [{
    address: guard,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: 'latest',
    topics: [REPORT_ACCEPTED_TOPIC, addressTopic(maker), strategyHash],
  }], fetchImpl);
  if (!Array.isArray(logs) || logs.length === 0) return null;
  const log = logs.at(-1);
  if (log?.removed || log.address?.toLowerCase() !== guard.toLowerCase() || !/^0x[0-9a-f]{64}$/i.test(log?.transactionHash ?? '')) throw new Error('RPC returned an invalid report log');
  const event = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
  if (event.eventName !== 'ReportAccepted' || event.args.maker.toLowerCase() !== maker.toLowerCase() || event.args.strategyHash.toLowerCase() !== strategyHash.toLowerCase()) throw new Error('Report event identity mismatch');
  return { transactionHash: log.transactionHash, blockNumber: BigInt(log.blockNumber), nonce: event.args.nonce, digest: event.args.digest };
}

export async function waitForAcceptedReport(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const intervalMs = options.intervalMs ?? 1_500;
  while (Date.now() < deadline) {
    const accepted = await findAcceptedReport(config, fetchImpl);
    if (accepted) {
      const stored = await readGuardReport({ ...config, blockNumber: accepted.blockNumber }, fetchImpl);
      if (stored.report.nonce === 0n || stored.report.nonce !== accepted.nonce || stored.digest !== accepted.digest || stored.report.strategyHash.toLowerCase() !== config.strategyHash.toLowerCase()
        || stored.report.maker.toLowerCase() !== config.maker.toLowerCase()) {
        throw new Error('Guard report does not match the requested mandate');
      }
      return { ...accepted, ...stored };
    }
    await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(intervalMs);
  }
  throw new Error('Timed out waiting for the Guard report');
}
