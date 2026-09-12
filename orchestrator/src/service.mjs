import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, parseAbi } from 'viem';

const HEX32 = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const POSITIVE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const STRATEGY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const routerAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
]);
const orderParameter = [{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} must be an object.`);
  return value;
}
function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, `${label} contains unknown fields.`);
}
function decimal(value, label, { percentage = false } = {}) {
  if (typeof value !== 'string' || !POSITIVE.test(value) || Number(value) <= 0 || (percentage && Number(value) > 100)) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return value;
}

export function parseCreate(input) {
  const body = object(input, 'Request');
  exactKeys(body, ['maker', 'providerStrategyIds', 'policy'], 'Request');
  if (typeof body.maker !== 'string' || !ADDRESS.test(body.maker) || /^0x0{40}$/i.test(body.maker)) throw new HttpError(400, 'Maker address is invalid.');
  if (!Array.isArray(body.providerStrategyIds) || body.providerStrategyIds.length < 1 || body.providerStrategyIds.length > 12
    || body.providerStrategyIds.some(id => typeof id !== 'string' || !STRATEGY_ID.test(id))
    || new Set(body.providerStrategyIds).size !== body.providerStrategyIds.length) throw new HttpError(400, 'Provider strategy IDs are invalid.');
  const policy = object(body.policy, 'Policy');
  exactKeys(policy, ['capitalBudgetUsdc', 'maxWethExposurePct', 'maxWethInventoryUsdc', 'maxSwapUsdc', 'validityMinutes'], 'Policy');
  const parsed = {
    capitalBudgetUsdc: decimal(policy.capitalBudgetUsdc, 'Capital budget'),
    maxWethExposurePct: decimal(policy.maxWethExposurePct, 'WETH exposure', { percentage: true }),
    maxWethInventoryUsdc: decimal(policy.maxWethInventoryUsdc, 'WETH inventory'),
    maxSwapUsdc: decimal(policy.maxSwapUsdc, 'Maximum swap'),
    validityMinutes: decimal(policy.validityMinutes, 'Validity'),
  };
  if (Number(parsed.maxWethInventoryUsdc) > Number(parsed.capitalBudgetUsdc) || Number(parsed.maxSwapUsdc) > Number(parsed.capitalBudgetUsdc)) {
    throw new HttpError(400, 'Inventory and swap limits cannot exceed the capital budget.');
  }
  return { maker: body.maker.toLowerCase(), providerStrategyIds: body.providerStrategyIds, policy: parsed };
}

export function validateState(value, expected) {
  const state = object(value, 'Runner response');
  if (typeof state.mandateId !== 'string' || !STRATEGY_ID.test(state.mandateId)) throw new Error('runner returned an invalid mandate ID');
  if (typeof state.maker !== 'string' || !ADDRESS.test(state.maker)) throw new Error('runner returned an invalid Maker address');
  if (!['normal', 'high-volatility', 'unknown'].includes(state.regime)) throw new Error('runner returned an invalid regime');
  if (!Array.isArray(state.strategies) || state.strategies.length < 1 || state.strategies.filter(s => s?.status === 'active').length > 1) throw new Error('runner returned an invalid strategy set');
  for (const strategy of state.strategies) {
    if (!strategy || !STRATEGY_ID.test(strategy.listingId) || typeof strategy.name !== 'string' || !HEX32.test(strategy.strategyHash)
      || !['active', 'standby', 'paused'].includes(strategy.status) || !/^(0|[1-9][0-9]*)$/.test(strategy.maxAmountPerSwapAtomic)) throw new Error('runner returned an invalid strategy');
  }
  const evidence = object(state.evidence, 'Evidence');
  if (evidence.chainId !== expected.chainId || evidence.networkName !== expected.networkName || !HEX32.test(evidence.reportDigest)
    || !HEX32.test(evidence.reportTransactionHash) || !/^[1-9][0-9]*$/.test(evidence.sequence)
    || Number.isNaN(Date.parse(evidence.expiresAt))) throw new Error('runner returned invalid or wrong-network evidence');
  const canonicalExplorer = `${expected.explorerUrl}/tx/${evidence.reportTransactionHash}`;
  if (evidence.reportExplorerUrl !== canonicalExplorer) throw new Error('runner returned a non-canonical report explorer URL');
  if (!Array.isArray(state.events)) throw new Error('runner returned invalid events');
  return state;
}

export async function verifyReceipt(rpcUrl, txHash, expectedStatus = '0x1', fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [txHash] }]) });
  if (!response.ok) throw new Error(`RPC receipt lookup failed (${response.status})`);
  const payload = await response.json();
  const chain = Array.isArray(payload) ? payload.find(item => item.id === 1) : null;
  const transaction = Array.isArray(payload) ? payload.find(item => item.id === 2) : null;
  if (chain?.error || transaction?.error || !chain?.result || !transaction?.result) throw new Error('transaction evidence is unavailable');
  if (transaction.result.transactionHash?.toLowerCase() !== txHash.toLowerCase() || transaction.result.status !== expectedStatus) throw new Error('transaction status does not match its claimed event');
  return { chainId: Number(BigInt(chain.result)), receipt: transaction.result };
}

export async function verifyAquaSwap(rpcUrl, router, txHash, expectedStrategyHash, expectedStatus, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [txHash] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getTransactionByHash', params: [txHash] },
  ]) });
  if (!response.ok) throw new Error(`RPC Aqua lookup failed (${response.status})`);
  const payload = await response.json();
  const result = id => Array.isArray(payload) ? payload.find(item => item.id === id)?.result : null;
  const chainId = result(1), receipt = result(2), transaction = result(3);
  if (!chainId || !receipt || !transaction || transaction.hash?.toLowerCase() !== txHash.toLowerCase()
    || receipt.transactionHash?.toLowerCase() !== txHash.toLowerCase()) throw new Error('Aqua transaction evidence is unavailable');
  if (transaction.to?.toLowerCase() !== router.toLowerCase() || receipt.status !== expectedStatus) throw new Error('Aqua transaction target or status does not match the claim');
  const call = decodeFunctionData({ abi: routerAbi, data: transaction.input });
  if (call.functionName !== 'swap') throw new Error('transaction is not an Aqua Router swap');
  const strategyHash = keccak256(encodeAbiParameters(orderParameter, [call.args[0]]));
  if (strategyHash.toLowerCase() !== expectedStrategyHash.toLowerCase()) throw new Error('Aqua swap uses a different strategy');
  const swapEvents = receipt.logs.filter(log => log.address?.toLowerCase() === router.toLowerCase()).flatMap(log => {
    try { const event = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics }); return event.eventName === 'Swapped' ? [event] : []; }
    catch { return []; }
  });
  if (expectedStatus === '0x1' && !swapEvents.some(event => event.args.orderHash?.toLowerCase() === strategyHash.toLowerCase())) throw new Error('successful Aqua swap emitted no matching Swapped event');
  if (expectedStatus === '0x0' && swapEvents.length) throw new Error('rejected Aqua swap unexpectedly emitted Swapped');
  const blockResponse = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }) });
  const block = blockResponse.ok ? (await blockResponse.json()).result : null;
  if (!block?.timestamp) throw new Error('Aqua transaction block is unavailable');
  return { chainId: Number(BigInt(chainId)), receipt, transaction, strategyHash, occurredAt: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
}

export function runAdapter(executable, request, timeoutMs = 120000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('confidential runner timed out')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) { child.kill('SIGKILL'); finish(new Error('runner output exceeded limit')); } });
    // Drain stderr without retaining it. A faulty runner must not leak private inputs into application logs.
    child.stderr.resume();
    child.once('error', finish);
    child.once('close', code => {
      if (code !== 0) return finish(new Error('confidential runner failed'));
      try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('confidential runner returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createService(config, dependencies = {}) {
  const runner = dependencies.runner ?? (request => runAdapter(config.runner, request, config.runnerTimeoutMs));
  const receipt = dependencies.verifyReceipt ?? ((hash, status) => verifyReceipt(config.rpcUrl, hash, status));
  const aquaSwap = dependencies.verifyAquaSwap ?? ((hash, strategyHash, status) => verifyAquaSwap(config.rpcUrl, config.router, hash, strategyHash, status));
  const stateDir = resolve(config.stateDir);
  const statePath = id => join(stateDir, `${id}.json`);
  const save = async state => {
    await mkdir(stateDir, { recursive: true });
    const target = statePath(state.mandateId), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  };
  const load = async id => JSON.parse(await readFile(statePath(id), 'utf8'));
  const accept = async (output, requiredStrategyIds = [], expectedMaker) => {
    const state = validateState(output, config);
    if (expectedMaker && state.maker.toLowerCase() !== expectedMaker.toLowerCase()) throw new Error('runner response is for a different Maker');
    const returnedIds = new Set(state.strategies.map(strategy => strategy.listingId));
    if (requiredStrategyIds.some(id => !returnedIds.has(id))) throw new Error('runner response does not contain the requested strategy set');
    const claims = new Map([[state.evidence.reportTransactionHash.toLowerCase(), '0x1']]);
    for (const event of state.events) {
      if (!event?.transactionHash) continue;
      if (!HEX32.test(event.transactionHash)) throw new Error('runner returned an invalid event transaction hash');
      const status = event.type === 'swap-rejected' ? '0x0' : '0x1';
      const key = event.transactionHash.toLowerCase();
      if (claims.has(key) && claims.get(key) !== status) throw new Error('runner assigned conflicting outcomes to one transaction');
      claims.set(key, status);
    }
    const verified = await Promise.all([...claims].map(([hash, status]) => receipt(hash, status)));
    if (verified.some(result => result?.chainId !== undefined && result.chainId !== config.chainId)) throw new Error('RPC returned evidence from the wrong chain');
    await save(state);
    return state;
  };
  return {
    async create(input) {
      const parsed = parseCreate(input);
      return accept(await runner({ action: 'create', input: parsed }), parsed.providerStrategyIds, parsed.maker);
    },
    async get(id) {
      if (!STRATEGY_ID.test(id)) throw new HttpError(400, 'Mandate ID is invalid.');
      let current;
      try { current = await load(id); } catch {}
      let output;
      try { output = await runner({ action: 'get', mandateId: id, current }); }
      catch (error) { if (current) output = current; else throw error; }
      if (output.mandateId !== id) throw new Error('runner returned the wrong mandate');
      return accept(output, [], current?.maker);
    },
    async add(id, input) {
      if (!STRATEGY_ID.test(id)) throw new HttpError(400, 'Mandate ID is invalid.');
      const body = object(input, 'Request'); exactKeys(body, ['providerStrategyId'], 'Request');
      if (typeof body.providerStrategyId !== 'string' || !STRATEGY_ID.test(body.providerStrategyId)) throw new HttpError(400, 'Provider strategy ID is invalid.');
      let current;
      try { current = await load(id); } catch { throw new HttpError(404, 'Mandate not found.'); }
      const output = await runner({ action: 'add-strategy', mandateId: id, providerStrategyId: body.providerStrategyId, current });
      if (output.mandateId !== id) throw new Error('runner returned the wrong mandate');
      return accept(output, [body.providerStrategyId], current.maker);
    },
    async recordExecution(id, input) {
      if (!STRATEGY_ID.test(id)) throw new HttpError(400, 'Mandate ID is invalid.');
      const body = object(input, 'Request'); exactKeys(body, ['providerStrategyId', 'transactionHash', 'outcome'], 'Request');
      if (!STRATEGY_ID.test(body.providerStrategyId ?? '') || !HEX32.test(body.transactionHash ?? '')
        || !['settled', 'rejected'].includes(body.outcome)) throw new HttpError(400, 'Execution evidence is invalid.');
      let current;
      try { current = await load(id); } catch { throw new HttpError(404, 'Mandate not found.'); }
      const strategy = current.strategies.find(item => item.listingId === body.providerStrategyId);
      if (!strategy) throw new HttpError(400, 'Strategy is not part of this mandate.');
      if (current.events.some(event => event.transactionHash?.toLowerCase() === body.transactionHash.toLowerCase())) return current;
      if (body.outcome === 'settled' && strategy.status !== 'active') throw new HttpError(409, 'Only the active strategy may settle.');
      if (body.outcome === 'rejected' && strategy.status === 'active') throw new HttpError(409, 'An active strategy rejection does not prove the strategy switch.');
      const evidence = await aquaSwap(body.transactionHash, strategy.strategyHash, body.outcome === 'settled' ? '0x1' : '0x0');
      if (evidence.chainId !== config.chainId) throw new Error('RPC returned Aqua evidence from the wrong chain');
      const explorerUrl = `${config.explorerUrl}/tx/${body.transactionHash}`;
      current.events = [{ id: `${body.transactionHash}-${body.outcome}`, type: body.outcome === 'settled' ? 'swap-settled' : 'swap-rejected',
        title: body.outcome === 'settled' ? `${strategy.name} swap settled` : `${strategy.name} swap blocked`,
        detail: body.outcome === 'settled' ? 'Aqua executed within the current Guard authorization.' : 'The inactive strategy was rejected by the Guard onchain.',
        occurredAt: evidence.occurredAt, transactionHash: body.transactionHash.toLowerCase(), explorerUrl }, ...current.events];
      await save(current);
      return current;
    },
  };
}
