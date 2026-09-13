import { createPublicClient, http, parseAbi, zeroHash } from 'viem';
import { encodeBuilderReport, builderTermsHash } from './builder-cre-protocol.mjs';

export const builderGuardAbi = parseAbi([
  'function getReport(address maker, bytes32 strategyHash) view returns ((uint16 schemaVersion,uint256 chainId,address guard,address router,address maker,bytes32 strategyHash,address token0,address token1,uint64 nonce,uint48 validAfter,uint48 validUntil,uint8 allowedDirections,uint128 maxAmount0PerSwap,uint128 maxAmount1PerSwap,uint128 maxPostBalance0,uint128 maxPostBalance1) report, bytes32 digest)',
  'function activeStrategyHash(address maker) view returns (bytes32)',
  'function strategyRevoked(address maker, bytes32 strategyHash) view returns (bool)',
  'function forwarder() view returns (address)', 'function router() view returns (address)',
  'function simulationMode() view returns (bool)', 'function reportSchemaVersion() view returns (uint16)',
  'event ReportAccepted(address indexed maker, bytes32 indexed strategyHash, uint64 nonce, bytes32 digest, uint48 validUntil)',
]);
const aquaAbi = parseAbi(['function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns (uint248 balance,uint8 tokensCount)']);
const jsonReport = report => Object.fromEntries(Object.entries(report).map(([key, value]) => [key, String(value)]));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Read-only chain evidence. The configured RPC can never receive a signed transaction here. */
export function createBuilderCreChain(profile, { rpcUrl, client = createPublicClient({ transport: http(rpcUrl, { timeout: 15000, retryCount: 1 }) }), confirmations = 2, maxBlockRange = 2000n }) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64 || maxBlockRange < 1n || maxBlockRange > 10000n) throw new Error('builder-chain-invalid-options');
  const read = (functionName, args, blockNumber) => client.readContract({ address: profile.guard, abi: builderGuardAbi, functionName, args, blockNumber });
  function domain(report, maker, strategyHash) {
    return report.chainId === String(profile.chainId) && same(report.guard, profile.guard) && same(report.router, profile.router) &&
      same(report.maker, maker) && same(report.strategyHash, strategyHash) && same(report.token0, profile.tokens[0].address) && same(report.token1, profile.tokens[1].address);
  }
  return {
    async snapshot(maker, strategyHash) {
      if (await client.getChainId() !== profile.chainId) throw new Error('builder-chain-mismatch');
      const block = await client.getBlock({ blockTag: 'latest' });
      if (block.number === null || !block.hash || Date.now() / 1000 - Number(block.timestamp) > 120 || Number(block.timestamp) > Date.now() / 1000 + 30) throw new Error('builder-chain-stale');
      const [stored, activeHash, revoked, forwarder, router, simulation, schema, balance0, balance1] = await Promise.all([
        read('getReport', [maker, strategyHash], block.number), read('activeStrategyHash', [maker], block.number),
        read('strategyRevoked', [maker, strategyHash], block.number), read('forwarder', [], block.number), read('router', [], block.number),
        read('simulationMode', [], block.number), read('reportSchemaVersion', [], block.number),
        ...profile.tokens.map(token => client.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [maker, profile.router, strategyHash, token.address], blockNumber: block.number })),
      ]);
      if (!same(forwarder, profile.forwarder) || !same(router, profile.router) || simulation !== true || Number(schema) !== 2) throw new Error('builder-chain-profile-mismatch');
      if (revoked || [balance0, balance1].some(balance => Number(balance[1]) === 255)) throw new Error('builder-chain-strategy-stopped');
      if (!same((await client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error('builder-chain-reorg');
      const report = stored[0].nonce === 0n ? null : encodeBuilderReport(jsonReport(stored[0]));
      if (report && (!domain(report.report, maker, strategyHash) || report.digest !== stored[1])) throw new Error('builder-chain-report-integrity');
      return { fromBlock: String(block.number), blockHash: block.hash, nonceFloor: String(stored[0].nonce), activeHash,
        termsHash: report ? builderTermsHash(report.report) : null, allowedDirections: report?.report.allowedDirections ?? null };
    },
    async accepted({ report: input, fromBlock, transactionHash }) {
      const expected = encodeBuilderReport(input), report = expected.report;
      if (!domain(report, report.maker, report.strategyHash) || await client.getChainId() !== profile.chainId) throw new Error('builder-chain-mismatch');
      const head = await client.getBlockNumber(), end = head - BigInt(confirmations - 1);
      const event = builderGuardAbi.find(item => item.type === 'event');
      let candidates = [];
      if (transactionHash) {
        let receipt;
        try { receipt = await client.getTransactionReceipt({ hash: transactionHash }); }
        catch (error) { if (error?.name === 'TransactionReceiptNotFoundError') return null; throw error; }
        if (receipt.blockNumber > end) return null;
        if (!same((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)) return null;
        if (receipt.status !== 'success') return { status: 'reverted', transactionHash, receipt: { blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash } };
        candidates = await client.getLogs({ address: profile.guard, event, args: { maker: report.maker, strategyHash: report.strategyHash }, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber, strict: true });
        candidates = candidates.filter(log => same(log.transactionHash, transactionHash));
      } else {
        // The candidate anchor is captured before simulation. Page a bounded
        // RPC range; do not use latestReportBlock, which loses older receipts.
        for (let start = BigInt(fromBlock); start <= end; start += maxBlockRange) {
          const last = start + maxBlockRange - 1n < end ? start + maxBlockRange - 1n : end;
          const logs = await client.getLogs({ address: profile.guard, event, args: { maker: report.maker, strategyHash: report.strategyHash }, fromBlock: start, toBlock: last, strict: true });
          candidates.push(...logs.filter(log => String(log.args.nonce) === report.nonce && same(log.args.digest, expected.digest)));
          if (candidates.length) break;
          if (start + maxBlockRange * 20n < end) throw new Error('builder-chain-reconciliation-window-too-large');
        }
      }
      const log = candidates.find(log => !log.removed && same(log.address, profile.guard) && same(log.args.maker, report.maker) &&
        same(log.args.strategyHash, report.strategyHash) && String(log.args.nonce) === report.nonce && same(log.args.digest, expected.digest));
      if (!log || !log.transactionHash || !log.blockHash || log.blockNumber === null || log.blockNumber > end) return null;
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      if (receipt.status !== 'success' || !same(receipt.blockHash, log.blockHash) || receipt.blockNumber !== log.blockNumber ||
        !same((await client.getBlock({ blockNumber: log.blockNumber })).hash, log.blockHash)) return null;
      // Require the event to be in the actual receipt, not only an RPC log index.
      if (!receipt.logs.some(item => item.logIndex === log.logIndex && same(item.address, profile.guard) && item.data === log.data && JSON.stringify(item.topics) === JSON.stringify(log.topics))) return null;
      const stored = await read('getReport', [report.maker, report.strategyHash], log.blockNumber);
      const readback = encodeBuilderReport(jsonReport(stored[0]));
      if (!domain(readback.report, report.maker, report.strategyHash) || readback.digest !== stored[1] || BigInt(readback.report.nonce) < BigInt(report.nonce)) throw new Error('builder-chain-readback-mismatch');
      if (readback.report.nonce === report.nonce && readback.digest !== expected.digest) throw new Error('builder-chain-readback-mismatch');
      return { transactionHash: log.transactionHash, receipt: { evidenceMode: 'cre-local-simulation', blockNumber: String(log.blockNumber), blockHash: log.blockHash,
        reportDigest: expected.digest, reportNonce: report.nonce, confirmations, readback: readback.digest === expected.digest ? 'matched' : 'superseded-in-same-block' } };
    },
  };
}
