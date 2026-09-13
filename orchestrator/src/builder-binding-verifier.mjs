import { latestAcceptedReport } from './guard-observer.mjs';

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

function same(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }

/**
 * Build the production read-only verifier used before a Maker signs a binding.
 * The Guard transaction is never sent here; the adapter only proves that the
 * supplied receipt and the current standing report are the same domain.
 */
export function createRpcBindingVerifier(rpcUrl, options = {}) {
  if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) return undefined;
  return async ({ owner, profile, artifact, reportDigest, reportTransactionHash, reportNonce }) => {
    const maker = owner.slice(7);
    if (!ADDRESS.test(maker) || !HASH.test(reportDigest) || !HASH.test(reportTransactionHash) || !/^[1-9][0-9]{0,19}$/.test(reportNonce))
      throw new Error('binding-proof-input-invalid');
    const strategyHash = artifact.payload.strategyHash;
    if (!HASH.test(strategyHash)) throw new Error('binding-proof-artifact-invalid');
    let accepted;
    try {
      accepted = await latestAcceptedReport({ rpcUrl: rpcUrl.trim(), guard: profile.guard, maker, strategyHash }, {
        expectedDigest: reportDigest.toLowerCase(),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch {
      // Do not let RPC/provider diagnostics reach the HTTP response or logs.
      throw new Error('binding-proof-unavailable');
    }
    const report = accepted.report;
    if (Number(report.schemaVersion) !== 2 || Number(report.chainId) !== profile.chainId
      || !same(report.guard, profile.guard) || !same(report.router, profile.router)
      || !same(report.maker, maker) || !same(report.strategyHash, strategyHash)
      || !same(report.token0, profile.tokens[0].address) || !same(report.token1, profile.tokens[1].address)
      || accepted.nonce.toString() !== reportNonce || !same(accepted.transactionHash, reportTransactionHash)
      || !same(accepted.digest, reportDigest)) throw new Error('binding-proof-mismatch');
    return {
      chainId: Number(report.chainId), maker: report.maker, guard: report.guard, router: report.router,
      strategyHash: report.strategyHash, reportSchema: 2, reportDigest: accepted.digest,
      reportTransactionHash: accepted.transactionHash, reportNonce: accepted.nonce.toString(), accepted: true,
    };
  };
}
