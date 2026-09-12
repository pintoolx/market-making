import { createPublicClient, http, parseAbi } from 'viem';
import { activationCatalog } from './activation-store.mjs';

const guardAbi = parseAbi([
  'function activeStrategyHash(address maker) view returns (bytes32)',
  'function getReport(address maker, bytes32 strategyHash) view returns ((uint16 schemaVersion,uint256 chainId,address guard,address router,address maker,bytes32 strategyHash,address token0,address token1,uint64 nonce,uint48 validAfter,uint48 validUntil,uint8 allowedDirections,uint128 maxAmount0PerSwap,uint128 maxAmount1PerSwap,uint128 maxPostBalance0,uint128 maxPostBalance1) report, bytes32 digest)',
]);
const aquaAbi = parseAbi(['function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns (uint248 balance,uint8 tokensCount)']);
const tokenAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)']);
const TOKENS = ['0xfff9976782d46cc05630d1f6ebab18b2324d6b14', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function assessReadiness({ report: r, activeHash, raw, wallets, allowances, now, programDeadline, strategyHash }) {
  const reasons = [];
  const authorized = r.nonce > 0n && same(activeHash, strategyHash) && r.allowedDirections > 0 && r.validAfter <= now && (Number(r.schemaVersion) === 2 ? Number(r.validUntil) === 0 : Number(r.schemaVersion) === 1 && now < r.validUntil);
  const shipped = raw.every(([balance, count]) => count === 2 && balance > 0n);
  const funded = shipped && raw.every(([balance], i) => wallets[i] >= balance && allowances[i] >= balance);
  const programValid = Number.isSafeInteger(programDeadline) && programDeadline >= now;
  if (!authorized) reasons.push('authorization-missing-inactive-or-expired');
  if (!shipped) reasons.push(raw.some(([, count]) => count === 255) ? 'docked' : 'liquidity-missing-or-one-sided');
  if (!funded) reasons.push('wallet-or-allowance-insufficient');
  if (!programValid) reasons.push(programDeadline ? 'program-expired' : 'program-deadline-unverified');
  return { phase: reasons.length ? 'not-ready' : 'ready-for-quote', authorized, shipped, funded, programValid, reasons };
}

/** Read-only, one block for all state. A successful future quote is still required for each trade. */
export async function readLpReadiness(config, maker, strategy, dependencies = {}) {
  if (config.chainId !== 11155111 || !config.guard || !config.aqua) return { phase: 'unverified', reasons: ['readiness-not-configured'] };
  const client = dependencies.client ?? createPublicClient({ transport: http(config.rpcUrl, { timeout: 15000, retryCount: 0 }) });
  if (await client.getChainId() !== config.chainId) throw new Error('Readiness RPC is on the wrong chain');
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const wall = Math.floor((dependencies.nowMs?.() ?? Date.now()) / 1000);
  if (now > wall + 15 || wall - now > 90) throw new Error('Readiness block is stale');
  const call = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args, blockNumber: block.number });
  const [[report], activeHash] = await Promise.all([
    call(config.guard, guardAbi, 'getReport', [maker, strategy.strategyHash]),
    call(config.guard, guardAbi, 'activeStrategyHash', [maker]),
  ]);
  if (report.nonce > 0n && (Number(report.chainId) !== config.chainId || !same(report.guard, config.guard) || !same(report.router, config.router)
    || !same(report.maker, maker) || !same(report.strategyHash, strategy.strategyHash) || !same(report.token0, TOKENS[0]) || !same(report.token1, TOKENS[1]))) throw new Error('Readiness report domain mismatch');
  const rows = await Promise.all(TOKENS.map(token => Promise.all([
    call(config.aqua, aquaAbi, 'rawBalances', [maker, config.router, strategy.strategyHash, token]),
    call(token, tokenAbi, 'balanceOf', [maker]), call(token, tokenAbi, 'allowance', [maker, config.aqua]),
  ])));
  const activated = config.stateDir ? (await activationCatalog(config.stateDir))[strategy.listingId] : undefined;
  const catalog = activated && same(activated.maker, maker) && same(activated.strategyHash, strategy.strategyHash)
    ? activated : config.strategies?.find(item => item.id === strategy.listingId && same(item.strategyHash, strategy.strategyHash));
  const result = assessReadiness({ report, activeHash, now, strategyHash: strategy.strategyHash,
    raw: rows.map(row => row[0]), wallets: rows.map(row => row[1]), allowances: rows.map(row => row[2]), programDeadline: catalog?.programDeadline });
  // A public snapshot expires quickly; neither persisted state nor a stalled browser can keep it ready forever.
  return { ...result, blockNumber: String(block.number), checkedAt: new Date(wall * 1000).toISOString(),
    validUntil: new Date(Math.min(wall + 30, result.authorized && Number(report.schemaVersion) === 1 ? Number(report.validUntil) : wall + 30,
      result.programValid ? catalog.programDeadline : wall + 30) * 1000).toISOString() };
}
