// Independent read-only verification of public CRE/SwapVM testnet evidence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, decodeEventLog, encodeAbiParameters, erc20Abi, http, keccak256, parseAbi, zeroHash } from 'viem';

const root = new URL('../../', import.meta.url), proofDir = new URL('../verification/live-market-guard/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const plan = read('workflow/.cache/live-auth/plan/plan.json');
const d = read('contracts/aqua-executor/deployments/11155111.json');
const guardAbi = read('contracts/aqua-executor/artifacts/AquaGuardV2.json').abi;
const reportAbi = read('docs/guard-report-v1/abi.json');
const aquaAbi = parseAbi(['function rawBalances(address,address,bytes32,address) view returns (uint248,uint8)']);
const rpc = 'https://sepolia.gateway.tenderly.co';
const client = createPublicClient({ transport: http(rpc, { timeout: 15000, retryCount: 4, retryDelay: 2000 }) });
// A public endpoint throttles bursts; serialize independent audit reads rather
// than retrying a large parallel batch at the same instant.
let queue = Promise.resolve();
const pc = new Proxy(client, { get(target, key) {
  const method = target[key];
  if (typeof method !== 'function') return method;
  return (...args) => {
    const run = queue.then(async () => { await delay(1200); return method(...args); });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
} });
assert.equal(await pc.getChainId(), 11155111);
const maker = plan.strategy.maker, taker = '0x9C69F55b9E6836b8e096C0F61202665C869922Cc';
const phases = [['cre-paused-probe.log', 0], ['cre-allow.log', 3], ['cre-buy-only.log', 1], ['cre-paused-final.log', 0]];
const reports = [], receipts = [];
let previousNonce = 0n;
for (const [file, directions] of phases) {
  const content = readFileSync(new URL(file, proofDir), 'utf8');
  const line = content.split('\n').find(s => s.includes('{"kind":"cre-delivery-receipt"'));
  assert.ok(line, `Missing delivery record: ${file}`);
  const record = JSON.parse(line.slice(line.indexOf('{')));
  const receipt = await pc.getTransactionReceipt({ hash: record.transactionHash });
  assert.equal(receipt.status, 'success');
  const events = receipt.logs.filter(l => l.address.toLowerCase() === d.guard.address).map(l => decodeEventLog({ abi: guardAbi, data: l.data, topics: l.topics }));
  const accepted = events.find(e => e.eventName === 'ReportAccepted');
  assert.ok(accepted);
  assert.equal(accepted.args.digest, record.reportDigest);
  assert.equal(accepted.args.nonce.toString(), record.nonce);
  assert.equal(accepted.args.maker.toLowerCase(), maker.toLowerCase());
  assert.equal(accepted.args.strategyHash, plan.strategyHash);
  const [report, digest] = await pc.readContract({ address: d.guard.address, abi: guardAbi, functionName: 'getReport', args: [maker, plan.strategyHash], blockNumber: receipt.blockNumber });
  assert.equal(digest, record.reportDigest);
  assert.equal(keccak256(encodeAbiParameters(reportAbi, [report])), digest);
  assert.equal(Number(report.allowedDirections), directions);
  assert.ok(BigInt(report.nonce) > previousNonce);
  previousNonce = BigInt(report.nonce);
  const active = await pc.readContract({ address: d.guard.address, abi: guardAbi, functionName: 'activeStrategyHash', args: [maker], blockNumber: receipt.blockNumber });
  assert.equal(active, directions ? plan.strategyHash : zeroHash);
  reports.push({ log: file, ...record, blockNumber: String(receipt.blockNumber), report, activeStrategyHash: active,
    binaryHash: content.match(/Binary hash: ([a-f0-9]+)/)?.[1], configHash: content.match(/Config hash: ([a-f0-9]+)/)?.[1] });
  receipts.push(receipt);
}
console.log('Verified four CRE reports, receiver events, historical digests and active-strategy states.');
const execution = {};
for (const [name, file] of [['ship', 'ship-resumed.log'], ['swap', 'swap.log'], ['dock', 'dock.log']]) {
  const content = readFileSync(new URL(file, proofDir), 'utf8');
  const result = JSON.parse(content.split('\n').findLast(line => line.startsWith('{"schema":"aqua-execution-result-v1"')));
  assert.equal(result.status, 'completed');
  assert.equal(result.strategyHash, plan.strategyHash);
  for (const tx of result.transactions) {
    const receipt = await pc.getTransactionReceipt({ hash: tx.hash });
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.blockNumber.toString(), tx.blockNumber);
    receipts.push(receipt);
  }
  execution[name] = result;
}
console.log('Verified executor ship, swap and dock receipts.');
const balancesAt = async blockNumber => ({
  aqua: await Promise.all(plan.strategy.tokens.map(token => pc.readContract({ address: d.aqua, abi: aquaAbi,
    functionName: 'rawBalances', args: [maker, d.router, plan.strategyHash, token], blockNumber }))),
  wallets: await Promise.all(plan.strategy.tokens.flatMap(address => [maker, taker].map(owner => pc.readContract({ address,
    abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber })))),
});
const swapHash = execution.swap.transactions.find(t => t.action === 'swap').hash;
const swapReceipt = await pc.getTransactionReceipt({ hash: swapHash });
const swapBefore = await balancesAt(swapReceipt.blockNumber - 1n), swapAfter = await balancesAt(swapReceipt.blockNumber);
assert.equal(swapAfter.wallets[2] - swapBefore.wallets[2], 500000n);
assert.equal(swapBefore.wallets[3] - swapAfter.wallets[3], 500000n);
const amountWeth = swapBefore.wallets[0] - swapAfter.wallets[0];
assert.ok(amountWeth > 0n);
assert.equal(swapAfter.wallets[1] - swapBefore.wallets[1], amountWeth);
const rejected = JSON.parse(readFileSync(new URL('rejection.json', proofDir), 'utf8'));
const rejectedReceipt = await pc.getTransactionReceipt({ hash: rejected.transactionHash });
assert.ok(rejected.approvalTransactionHash);
const rejectionApproval = await pc.getTransactionReceipt({ hash: rejected.approvalTransactionHash });
assert.equal(rejectionApproval.status, 'success');
assert.equal(rejectedReceipt.status, 'reverted');
assert.equal(rejectedReceipt.logs.length, 0);
const rejectedBefore = await balancesAt(rejectedReceipt.blockNumber - 1n), rejectedAfter = await balancesAt(rejectedReceipt.blockNumber);
assert.deepEqual(rejectedAfter, rejectedBefore);
receipts.push(rejectedReceipt);
receipts.push(rejectionApproval);
const cleanup = JSON.parse(readFileSync(new URL('cleanup.json', proofDir), 'utf8'));
for (const tx of cleanup.transactions) {
  const receipt = await pc.getTransactionReceipt({ hash: tx.hash });
  assert.equal(receipt.status, 'success');
  receipts.push(receipt);
}
const finalBlock = await pc.getBlock({ blockTag: 'latest' });
const final = await balancesAt(finalBlock.number);
assert.ok(final.aqua.every(([balance, count]) => balance === 0n && count === 255));
const allowances = await Promise.all(plan.strategy.tokens.flatMap(address => [[maker, d.aqua], [taker, d.router]].map(([owner, spender]) => pc.readContract({ address,
  abi: erc20Abi, functionName: 'allowance', args: [owner, spender], blockNumber: finalBlock.number }))));
assert.ok(allowances.every(value => value === 0n));
const active = await pc.readContract({ address: d.guard.address, abi: guardAbi, functionName: 'activeStrategyHash', args: [maker], blockNumber: finalBlock.number });
assert.equal(active, zeroHash);
const uniqueReceipts = [...new Map(receipts.map(r => [r.transactionHash, r])).values()];
const finalSourceSha256 = {};
const files = [
  'workflow/package.json', 'workflow/bun.lock', 'workflow/market-maker-auth/main.ts', 'workflow/market-maker-auth/workflow.ts',
  'workflow/src/publish.ts', 'workflow/src/intersect.ts', 'workflow/src/types.ts', 'workflow/src/encode.ts',
  'workflow/src/market-math.ts', 'workflow/src/market-observation.ts', 'workflow/guard-report/delivery.ts', 'workflow/guard-report/config.ts',
  'workflow/guard-report/report.ts', 'workflow/fixtures/public-live-demo.json', 'workflow/scripts/simulate-public-demo.mjs',
  'workflow/scripts/verify-live-guard.mjs', 'contracts/aqua-executor/scripts/cre-live-plan.ts', 'contracts/aqua-executor/scripts/cre-live-reject.ts',
  'contracts/aqua-executor/scripts/cre-risk-prices.ts', 'contracts/aqua-executor/src/kraken-risk-prices.ts',
  'contracts/aqua-executor/scripts/cre-live-close.ts',
  'contracts/aqua-executor/src/execution-controller.ts', 'contracts/aqua-executor/src/durable-send.ts',
  'contracts/aqua-executor/contracts/AquaGuardV2.sol', 'contracts/aqua-executor/artifacts/AquaGuardV2.json',
  ...readdirSync(new URL('workflow/src/market-data/', root)).filter(f => /\.(ts|json)$/.test(f)).map(f => `workflow/src/market-data/${f}`),
];
for (const file of files) finalSourceSha256[file] = createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex');
const result = { verifiedAt: new Date().toISOString(), rpc, chainId: 11155111, maker, taker, strategyHash: plan.strategyHash,
  guard: d.guard, reports, execution, swap: { hash: swapHash, amountUsdcAtomic: '500000', amountWethAtomic: amountWeth, before: swapBefore, after: swapAfter },
  rejection: { ...rejected, independentlyVerifiedBefore: rejectedBefore, independentlyVerifiedAfter: rejectedAfter },
  final: { blockNumber: finalBlock.number, blockHash: finalBlock.hash, ...final, allowances, activeStrategyHash: active },
  transactions: uniqueReceipts.map(r => ({ hash: r.transactionHash, status: r.status, blockNumber: r.blockNumber, from: r.from, to: r.to,
    gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice })),
  finalSourceSha256, sourceScope: 'Hashes identify final verified source. Per-run WASM binary/config hashes are preserved separately in the CLI logs.',
  limits: ['CLI simulation using public synthetic policies, not DON deployment or real TEE attestation.',
    'Single concentrated strategy tested; frontend publication, A/B strategy replacement and other templates are separate work.'] };
writeFileSync(new URL('independent-verification.json', proofDir), JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
writeFileSync(new URL('plan.json', proofDir), JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({ reports: reports.length, transactions: uniqueReceipts.length, swapHash, amountWethAtomic: String(amountWeth),
  rejectionHash: rejected.transactionHash, finalDocked: true, allowancesZero: true, activeStrategyCleared: true }));
