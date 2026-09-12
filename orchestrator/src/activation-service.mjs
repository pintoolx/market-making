import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256 } from 'viem';
import { sepolia } from 'viem/chains';
import { spawn } from 'node:child_process';
import { aquaActivationAbi } from '../../shared/aqua-activation.mjs';
import { activationCatalog, activationId, activationStore, syncActivationBindings } from './activation-store.mjs';

function compile(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ACTIVATION_COMPILER_BIN || 'bun', [fileURLToPath(new URL('../../contracts/aqua-executor/src/prepare-activation.ts', import.meta.url))], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stderr.resume(); // Never log a signed publication's ciphertext.
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 100000) child.kill('SIGKILL'); });
    child.stdin.on('error', () => {});
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('close', code => {
      clearTimeout(timeout);
      try { if (code !== 0) throw new Error('The strategy could not be prepared. Check allocation limits and retry when market data is available.'); resolve(JSON.parse(output)); }
      catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createActivationService(config, registry, dependencies = {}) {
  const store = activationStore(config.stateDir);
  const client = dependencies.activationClient ?? createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  const compiler = dependencies.compileActivation ?? compile;
  const sync = dependencies.syncActivationBindings ?? (() => syncActivationBindings(config.stateDir, config.activationConfigPath));
  let confirming = Promise.resolve();
  const activeRelease = async (id, version) => {
    const [record, latest] = await Promise.all([registry.read(id, version), registry.latest(id)]);
    if (record.release.state !== 'published' || latest?.release.state !== 'published' || version <= (latest.withdrawnThrough ?? 0)) throw new Error('This version has been withdrawn. Choose a published version.');
    return record;
  };
  const publicRecord = r => ({ id: r.id, maker: r.maker, release: r.plan.release, name: r.plan.catalogEntry.name,
    chainId: 11155111, aqua: r.plan.deployment.aqua, router: r.plan.deployment.router,
    tokens: r.plan.request.strategy.tokens, amounts: r.amounts, strategy: r.plan.strategy, strategyHash: r.plan.strategyHash,
    range: r.plan.range, reference: r.plan.reference, programDeadline: r.plan.catalogEntry.programDeadline,
    transactionHash: r.transactionHash ?? null });

  async function funding(r, blockNumber) {
    if (await client.getChainId() !== 11155111) throw new Error('Activation requires Ethereum Sepolia.');
    return Promise.all(r.plan.request.strategy.tokens.map(async (token, i) => {
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [r.maker], blockNumber }),
        client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [r.maker, r.plan.deployment.aqua], blockNumber }),
      ]);
      return { token, balance: String(balance), allowance: String(allowance), required: r.amounts[i] };
    }));
  }
  return {
    async prepare(input) {
      if (config.chainId !== 11155111 || !input || Object.keys(input).some(k => !['id', 'releaseId', 'version', 'maker', 'amounts'].includes(k))
        || !activationId.test(input.id ?? '') || !/^[0-9a-f]{40}-clmm$/.test(input.releaseId ?? '')
        || !Number.isSafeInteger(input.version) || input.version < 1 || typeof input.maker !== 'string'
        || input.maker.toLowerCase() !== config.strategyMaker || !Array.isArray(input.amounts) || input.amounts.length !== 2
        || input.amounts.some(a => typeof a !== 'string' || !/^[1-9][0-9]{0,76}$/.test(a))) throw new Error('Choose a published version, valid token amounts and the connected Maker wallet.');
      const publication = await activeRelease(input.releaseId, input.version);
      const maker = input.maker.toLowerCase();
      const existingCatalog = await activationCatalog(config.stateDir);
      const bound = existingCatalog[`${input.releaseId}.v${input.version}`];
      if (bound) throw new Error('This version is already enabled. Refresh the marketplace to use it.');
      let existing;
      try { existing = await store.read(input.id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        if (existing.maker !== maker || existing.plan.release.digest !== publication.digest || JSON.stringify(existing.amounts) !== JSON.stringify(input.amounts)) throw new Error('Activation inputs changed. Review a new activation.');
        return publicRecord(existing);
      }
      const plan = await compiler({ publication, maker, amounts: input.amounts });
      if (plan.release.digest !== publication.digest || plan.release.id !== input.releaseId || plan.release.version !== input.version
        || plan.request.strategy.maker.toLowerCase() !== maker || plan.strategyHash !== keccak256(plan.strategy)
        || plan.deployment.aqua.toLowerCase() !== config.aqua.toLowerCase() || plan.deployment.router.toLowerCase() !== config.router.toLowerCase()
        || plan.deployment.guard.address.toLowerCase() !== config.guard.toLowerCase()) throw new Error('Compiled activation does not match the selected deployment and publication.');
      const record = { id: input.id, maker, amounts: input.amounts, plan };
      await store.insert(record);
      return publicRecord(record);
    },
    async get(id) {
      const record = await store.read(id);
      await activeRelease(record.plan.release.id, record.plan.release.version);
      return { ...publicRecord(record), funding: await funding(record, await client.getBlockNumber()) };
    },
    async confirm(id, input) {
      // Serialize confirmations so concurrent requests cannot retarget one published version.
      const work = confirming.catch(() => {}).then(async () => {
        if (!input || Object.keys(input).some(k => k !== 'transactionHash') || !/^0x[0-9a-f]{64}$/i.test(input.transactionHash ?? '')) throw new Error('A confirmed wallet transaction is required.');
        const record = await store.read(id);
        await activeRelease(record.plan.release.id, record.plan.release.version);
        const catalog = await activationCatalog(config.stateDir);
        const previous = catalog[`${record.plan.release.id}.v${record.plan.release.version}`];
        if (previous && previous.strategyHash !== record.plan.strategyHash) throw new Error('This version already has another confirmed activation.');
        if (record.transactionHash && record.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) throw new Error('Activation already has a different receipt.');
        const [receipt, transaction] = await Promise.all([
          client.getTransactionReceipt({ hash: input.transactionHash }), client.getTransaction({ hash: input.transactionHash }),
        ]);
        const data = encodeFunctionData({ abi: aquaActivationAbi, functionName: 'ship', args: [record.plan.deployment.router, record.plan.strategy, record.plan.request.strategy.tokens, record.amounts.map(BigInt)] });
        if (receipt.status !== 'success' || transaction.from.toLowerCase() !== record.maker || transaction.to?.toLowerCase() !== record.plan.deployment.aqua.toLowerCase()
          || transaction.input.toLowerCase() !== data.toLowerCase() || transaction.value !== 0n || transaction.blockHash !== receipt.blockHash) throw new Error('The transaction does not confirm this Maker activation.');
        const latestBlock = await client.getBlockNumber();
        if (record.plan.catalogEntry.programDeadline <= Math.floor(Date.now() / 1000)) throw new Error('This activation program has expired.');
        const coverage = await funding(record, latestBlock);
        const raw = await Promise.all(record.plan.request.strategy.tokens.map(token => client.readContract({
          address: record.plan.deployment.aqua, abi: aquaActivationAbi, functionName: 'rawBalances',
          args: [record.maker, record.plan.deployment.router, record.plan.strategyHash, token], blockNumber: receipt.blockNumber,
        })));
        if (raw.some(([balance, count], i) => count !== 2 || balance !== BigInt(record.amounts[i]))) throw new Error('Aqua did not register the expected balances.');
        const live = await Promise.all(record.plan.request.strategy.tokens.map(token => client.readContract({
          address: record.plan.deployment.aqua, abi: aquaActivationAbi, functionName: 'rawBalances',
          args: [record.maker, record.plan.deployment.router, record.plan.strategyHash, token], blockNumber: latestBlock,
        })));
        if (live.some(([, count]) => count !== 2)) throw new Error('This Aqua strategy is no longer registered.');
        if (coverage.some(f => BigInt(f.balance) < BigInt(f.required) || BigInt(f.allowance) < BigInt(f.required))) throw new Error('The Maker wallet needs sufficient token balances and Aqua approval.');
        await store.confirm({ ...record, transactionHash: input.transactionHash });
        await sync();
        return { ...publicRecord(record), transactionHash: input.transactionHash };
      });
      confirming = work;
      return work;
    },
  };
}
