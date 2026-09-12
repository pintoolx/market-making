import { encodeDeployData, encodeFunctionData, parseAbi, keccak256, toBytes, toHex, zeroAddress, zeroHash } from 'viem';
import { namehash, packetToBytes } from 'viem/ens';
import ethRegistrarAbi from './ETHRegistrar.json' with { type: 'json' };
import { deployments, registryAbi, factoryAbi, resolverAbi, registrarArtifact, sameAddress, matchingRegistrarCode, createEnsReader } from './chain.mjs';
import { normalizeRoot, normalizeLabel, strategyName, ALL_ROLES, NAME_ROLES, REGISTRAR_KEY, RELEASE_KEY, parseReleasePointer } from './schema.mjs';

const tokenAbi = parseAbi(['function mint(address to,uint256 amount)', 'function approve(address spender,uint256 amount) returns(bool)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const target = key => deployments.contracts[key].address;
const freshSalt = () => BigInt(toHex(crypto.getRandomValues(new Uint8Array(32))));

export function ensTransactions(client, wallet, onProgress = () => {}) {
  const account = wallet.account?.address ?? wallet.account;
  if (!account) throw new Error('Connect an Ethereum wallet.');
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const confirmedReceipt = async hash => {
    // Wallets may return after mining. Read that receipt before installing a block watcher.
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash }); } catch { /* Not mined yet. */ }
    return receipt ?? client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
  };
  async function transact(title, address, abi, functionName, args = []) {
    if (await client.getChainId() !== 11155111 || await wallet.getChainId() !== 11155111) throw new Error('Switch your wallet to Ethereum Sepolia.');
    onProgress({ title: `Review in wallet: ${title}` });
    const simulation = await client.simulateContract({ address, abi, functionName, args, account });
    const hash = await wallet.writeContract({ ...simulation.request, account: wallet.account });
    onProgress({ title: `Confirming: ${title}`, hash });
    const receipt = await confirmedReceipt(hash);
    if (receipt.status !== 'success') throw new Error(`${title} reverted. Your previous completed steps are preserved.`);
    onProgress({ title: `Confirmed: ${title}`, hash });
    return { result: simulation.result, receipt };
  }
  async function proxy(implementation, data, title) {
    const { result } = await transact(title, target('VerifiableFactory'), factoryAbi, 'deployProxy', [target(implementation), freshSalt(), data]);
    if (!sameAddress(await read(target('VerifiableFactory'), factoryAbi, 'verifyContract', [result]), target(implementation))) throw new Error('New ENS proxy verification failed.');
    return result;
  }
  const newRegistry = () => proxy('UserRegistryImpl', encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [account, ALL_ROLES] }), 'Create namespace registry');
  const newResolver = () => proxy('PermissionedResolverImpl', encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [account, ALL_ROLES, []] }), 'Create your resolver');
  async function rootState(rootName) {
    const root = normalizeRoot(rootName), label = root.split('.')[0];
    const state = await read(target('ETHRegistry'), registryAbi, 'getState', [BigInt(keccak256(toBytes(label)))]);
    return { root, label, state };
  }
  async function ensureRootContracts(rootName, saved = {}, persist = () => {}) {
    const { label, state } = await rootState(rootName);
    if (state.status === 2 && !sameAddress(state.latestOwner, account)) throw new Error('This platform name belongs to another wallet.');
    const result = { ...saved };
    if (state.status === 2) {
      result.registry = await read(target('ETHRegistry'), registryAbi, 'getSubregistry', [label]);
      result.resolver = await read(target('ETHRegistry'), registryAbi, 'getResolver', [label]);
    }
    if (!result.registry || sameAddress(result.registry, zeroAddress)) { result.registry = await newRegistry(); persist(result); }
    if (!result.resolver || sameAddress(result.resolver, zeroAddress)) { result.resolver = await newResolver(); persist(result); }
    for (const [key, impl] of [['registry', 'UserRegistryImpl'], ['resolver', 'PermissionedResolverImpl']]) {
      if (!sameAddress(await read(target('VerifiableFactory'), factoryAbi, 'verifyContract', [result[key]]), target(impl))) throw new Error(`The existing ${key} uses an unsupported implementation. Keep its records and configure a supported ENSv2 instance before continuing.`);
    }
    if (!await read(result.registry, registryAbi, 'hasRootRoles', [1n | (1n << 128n), account])
      || !await read(result.resolver, resolverAbi, 'hasRootRoles', [1n << 4n, account])) throw new Error('This wallet does not control the proposed namespace contracts.');
    if (state.status === 2) {
      if (!sameAddress(await read(target('ETHRegistry'), registryAbi, 'getSubregistry', [label]), result.registry)) await transact('Connect platform registry', target('ETHRegistry'), registryAbi, 'setSubregistry', [BigInt(keccak256(toBytes(label))), result.registry]);
      if (!sameAddress(await read(target('ETHRegistry'), registryAbi, 'getResolver', [label]), result.resolver)) await transact('Connect platform resolver', target('ETHRegistry'), registryAbi, 'setResolver', [BigInt(keccak256(toBytes(label))), result.resolver]);
    }
    return result;
  }
  async function prepareRoot(rootName, saved = {}, persist = () => {}) {
    const { root, label, state } = await rootState(rootName);
    if (state.status === 2) { const p = await ensureRootContracts(root, saved, persist); return { ...p, registered: true }; }
    if (!await read(target('ETHRegistrar'), ethRegistrarAbi, 'isAvailable', [label])) throw new Error('This platform name is unavailable.');
    const result = await ensureRootContracts(root, saved, persist);
    result.secret ??= toHex(crypto.getRandomValues(new Uint8Array(32)));
    result.duration ??= Math.max(365 * 86400, Number(await read(target('ETHRegistrar'), ethRegistrarAbi, 'MIN_REGISTER_DURATION')));
    persist(result);
    const [base, premium] = await read(target('ETHRegistrar'), ethRegistrarAbi, 'getRegisterPrice', [label, BigInt(result.duration), deployments.mockUsdc]);
    const price = base + premium;
    if (await read(deployments.mockUsdc, tokenAbi, 'balanceOf', [account]) < price) await transact('Mint Sepolia ENS test USDC', deployments.mockUsdc, tokenAbi, 'mint', [account, price]);
    if (await read(deployments.mockUsdc, tokenAbi, 'allowance', [account, target('ETHRegistrar')]) < price) await transact('Approve ENS registration fee', deployments.mockUsdc, tokenAbi, 'approve', [target('ETHRegistrar'), price]);
    result.commitment = await read(target('ETHRegistrar'), ethRegistrarAbi, 'makeCommitment', [label, account, result.secret, result.registry, result.resolver, BigInt(result.duration), zeroHash]);
    const committedAt = await read(target('ETHRegistrar'), ethRegistrarAbi, 'commitmentAt', [result.commitment]);
    const maxAge = await read(target('ETHRegistrar'), ethRegistrarAbi, 'MAX_COMMITMENT_AGE');
    const block = await client.getBlock();
    if (committedAt === 0n || committedAt + maxAge < block.timestamp) await transact('Commit platform name registration', target('ETHRegistrar'), ethRegistrarAbi, 'commit', [result.commitment]);
    const started = await read(target('ETHRegistrar'), ethRegistrarAbi, 'commitmentAt', [result.commitment]);
    result.readyAt = Number(started + await read(target('ETHRegistrar'), ethRegistrarAbi, 'MIN_COMMITMENT_AGE'));
    persist(result);
    return result;
  }
  async function registerRoot(rootName, saved) {
    const { label, state } = await rootState(rootName);
    if (state.status === 2) { if (!sameAddress(state.latestOwner, account)) throw new Error('Name belongs to another wallet.'); return; }
    if (!saved?.secret || !saved?.registry || !saved?.resolver || !saved.duration) throw new Error('Prepare the name registration first.');
    await ensureRootContracts(rootName, saved);
    await transact('Register platform ENS name', target('ETHRegistrar'), ethRegistrarAbi, 'register', [label, account, saved.secret, saved.registry, saved.resolver, BigInt(saved.duration), deployments.mockUsdc, zeroHash]);
    const confirmed = await rootState(rootName);
    if (confirmed.state.status !== 2 || !sameAddress(confirmed.state.latestOwner, account)) throw new Error('Name registration could not be verified.');
  }
  async function enablePlatform(rootName, saved = {}, persist = () => {}) {
    const { root, label, state } = await rootState(rootName);
    if (state.status !== 2 || !sameAddress(state.latestOwner, account)) throw new Error('Register the platform name with this wallet first.');
    const result = await ensureRootContracts(root, saved, persist);
    const existing = await client.getEnsText({ name: root, key: REGISTRAR_KEY });
    if (existing) {
      const platform = await createEnsReader({ rootName: root, client }).platform();
      return { ...result, registrar: platform.registrar };
    }
    if (!result.registrar) {
      if (await client.getChainId() !== 11155111 || await wallet.getChainId() !== 11155111) throw new Error('Switch your wallet to Ethereum Sepolia.');
      onProgress({ title: 'Estimating Provider registrar deployment fees' });
      const deployment = { abi: registrarArtifact.abi, bytecode: registrarArtifact.bytecode,
        args: [target('ETHRegistry'), result.registry, target('VerifiableFactory'), target('UserRegistryImpl'), target('PermissionedResolverImpl'), label] };
      // Some wallets cannot estimate contract creation through their own RPC.
      // Estimate the exact constructor through our Sepolia client before requesting confirmation.
      const [estimate, fees] = await Promise.all([
        client.estimateGas({ account, data: encodeDeployData(deployment), value: 0n }),
        client.estimateFeesPerGas({ type: 'eip1559' }),
      ]);
      onProgress({ title: 'Review in wallet: deploy Provider name registrar' });
      const hash = await wallet.deployContract({ ...deployment, account: wallet.account, value: 0n,
        gas: (estimate * 120n + 99n) / 100n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      onProgress({ title: 'Confirming Provider name registrar', hash });
      const receipt = await confirmedReceipt(hash);
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Registrar deployment failed.');
      result.registrar = receipt.contractAddress; persist(result);
    }
    if (!matchingRegistrarCode(await client.getCode({ address: result.registrar }))) throw new Error('Saved registrar code differs from PinTool.');
    for (const [getter, expected] of [['REGISTRY', result.registry], ['FACTORY', target('VerifiableFactory')], ['REGISTRY_IMPLEMENTATION', target('UserRegistryImpl')], ['RESOLVER_IMPLEMENTATION', target('PermissionedResolverImpl')], ['ETH_REGISTRY', target('ETHRegistry')]]) {
      if (!sameAddress(await read(result.registrar, registrarArtifact.abi, getter), expected)) throw new Error('Saved registrar is bound to a different namespace or implementation.');
    }
    if (await read(result.registrar, registrarArtifact.abi, 'ROOT_NODE') !== namehash(root)) throw new Error('Saved registrar uses a different root name.');
    await transact('Enable Provider name registration', result.registry, registryAbi, 'grantRootRoles', [1n, result.registrar]);
    await transact('Publish platform registrar', result.resolver, resolverAbi, 'setText', [namehash(root), REGISTRAR_KEY, result.registrar]);
    await createEnsReader({ rootName: root, client }).platform();
    return result;
  }
  async function claimProvider(rootName, label) {
    const reader = createEnsReader({ rootName, client }), platform = await reader.platform();
    await transact(`Claim ${normalizeLabel(label)}.${platform.rootName}`, platform.registrar, registrarArtifact.abi, 'register', [normalizeLabel(label)]);
    return reader.provider(account);
  }
  async function registerStrategy(rootName, label) {
    const reader = createEnsReader({ rootName, client }), status = await reader.provider(account);
    if (!status.provider) throw new Error('Claim your Provider name first.');
    label = normalizeLabel(label);
    const name = `${label}.${status.provider.name}`, id = BigInt(keccak256(toBytes(label)));
    const state = await read(status.provider.registry, registryAbi, 'getState', [id]);
    if (state.status === 2) { if (!sameAddress(state.latestOwner, account)) throw new Error('Strategy name belongs to another wallet.'); return name; }
    await transact(`Create ${name}`, status.provider.registry, registryAbi, 'register', [label, account, zeroAddress, status.provider.resolver, NAME_ROLES | (NAME_ROLES << 128n), BigInt(status.provider.expiry)]);
    await reader.describeName(name);
    return name;
  }
  async function publishPointer(rootName, name, pointer) {
    name = strategyName(name, rootName); pointer = parseReleasePointer(pointer);
    const reader = createEnsReader({ rootName, client }), found = await reader.describeName(name);
    if (!sameAddress(found.provider, pointer.provider)) throw new Error('Publication Provider differs from the ENS owner.');
    await transact(`Publish version ${pointer.version} to ENS`, found.resolver, resolverAbi, 'setText', [namehash(name), RELEASE_KEY, JSON.stringify(pointer)]);
    const confirmed = await reader.resolve(name);
    if (JSON.stringify(confirmed.pointer) !== JSON.stringify(pointer)) throw new Error('ENS changed after publication. Refresh to verify the current version.');
    return confirmed;
  }
  async function delegate(rootName, name, delegateAddress, grant) {
    if (!/^0x[0-9a-f]{40}$/i.test(delegateAddress) || sameAddress(delegateAddress, zeroAddress) || sameAddress(delegateAddress, account)) throw new Error('Use a different nonzero Ethereum wallet for the publisher.');
    const reader = createEnsReader({ rootName, client }), found = await reader.describeName(name);
    if (!sameAddress(found.provider, account)) throw new Error('Only the Provider manages this delegation in PinTool.');
    await transact(`${grant ? 'Authorize' : 'Revoke'} strategy publisher`, found.resolver, resolverAbi, 'authorizeTextRoles', [toHex(packetToBytes(found.name)), RELEASE_KEY, delegateAddress, grant]);
    const result = await reader.delegation(name, delegateAddress);
    if (!grant && result.allowed) throw new Error('The specific grant was revoked, but this account still has broader resolver permissions. Remove those in ENS before treating access as revoked.');
    if (grant && !result.allowed) throw new Error('Publisher permission could not be verified.');
    return result;
  }
  return { prepareRoot, registerRoot, enablePlatform, claimProvider, registerStrategy, publishPointer, delegate };
}
