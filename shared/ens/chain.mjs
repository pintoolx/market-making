import { createPublicClient, http, keccak256, toBytes, zeroAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { namehash } from 'viem/ens';
import deployments from './deployments.json' with { type: 'json' };
import registryAbi from './UserRegistryImpl.json' with { type: 'json' };
import factoryAbi from './VerifiableFactory.json' with { type: 'json' };
import registrarArtifact from './PinToolNamespaceRegistrar.json' with { type: 'json' };
import resolverAbi from './PermissionedResolverImpl.json' with { type: 'json' };
import { normalizeRoot, strategyName, parseReleasePointer, RELEASE_KEY, REGISTRAR_KEY, SET_TEXT_ROLE, textResource } from './schema.mjs';

export { deployments, registryAbi, factoryAbi, registrarArtifact, resolverAbi };
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = key => deployments.contracts[key].address;

export function matchingRegistrarCode(code) {
  if (!code || code.length !== registrarArtifact.deployedBytecode.length) return false;
  const clean = value => {
    const chars = value.toLowerCase().split('');
    for (const refs of Object.values(registrarArtifact.immutableReferences)) for (const { start, length } of refs) chars.fill('0', 2 + start * 2, 2 + (start + length) * 2);
    return chars.join('');
  };
  return clean(code) === clean(registrarArtifact.deployedBytecode);
}

export function createEnsReader({ rootName = 'pintool.eth', rpcUrl = 'https://ethereum-sepolia-rpc.publicnode.com', client } = {}) {
  const root = normalizeRoot(rootName);
  client ??= createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  const read = (at, target, abi, functionName, args = []) => client.readContract({ address: target, abi, functionName, args, blockNumber: at.number });
  const snapshot = async () => {
    if (await client.getChainId() !== 11155111) throw new Error('ENS requires Ethereum Sepolia.');
    const block = await client.getBlock();
    if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 180) throw new Error('ENS chain snapshot is stale.');
    return block;
  };
  const provenance = async (at, proxy, implementation) => {
    if (!proxy || sameAddress(proxy, zeroAddress)) throw new Error('ENS registry or resolver is missing.');
    if (!sameAddress(await read(at, address('VerifiableFactory'), factoryAbi, 'verifyContract', [proxy]), address(implementation))) throw new Error('ENS contract is not the supported ENSv2 implementation.');
  };
  const state = async (at, registry, label) => {
    const result = await read(at, registry, registryAbi, 'getState', [BigInt(keccak256(toBytes(label)))]);
    if (result.status !== 2 || result.expiry <= at.timestamp) throw new Error('ENS name is unregistered or expired.');
    return result;
  };
  async function platform(at = undefined) {
    at ??= await snapshot();
    const label = root.split('.')[0], eth = address('ETHRegistry');
    const rootState = await state(at, eth, label);
    const registry = await read(at, eth, registryAbi, 'getSubregistry', [label]);
    await provenance(at, registry, 'UserRegistryImpl');
    const registrar = await client.getEnsText({ name: root, key: REGISTRAR_KEY, blockNumber: at.number });
    if (!/^0x[0-9a-f]{40}$/i.test(registrar ?? '')) throw new Error('Platform name registration is not configured yet.');
    if (!matchingRegistrarCode(await client.getCode({ address: registrar, blockNumber: at.number }))) throw new Error('Platform registrar code does not match PinTool.');
    const [boundRegistry, factory, registryImpl, resolverImpl, ethRegistry, rootNode, enabled] = await Promise.all([
      ...['REGISTRY', 'FACTORY', 'REGISTRY_IMPLEMENTATION', 'RESOLVER_IMPLEMENTATION', 'ETH_REGISTRY', 'ROOT_NODE'].map(fn => read(at, registrar, registrarArtifact.abi, fn)),
      read(at, registry, registryAbi, 'hasRootRoles', [1n, registrar]),
    ]);
    if (!sameAddress(boundRegistry, registry) || !sameAddress(factory, address('VerifiableFactory')) || !sameAddress(registryImpl, address('UserRegistryImpl'))
      || !sameAddress(resolverImpl, address('PermissionedResolverImpl')) || !sameAddress(ethRegistry, eth) || rootNode !== namehash(root) || !enabled) throw new Error('Platform registrar binding or permissions are invalid.');
    return { rootName: root, registry, registrar, owner: rootState.latestOwner, expiry: rootState.expiry.toString(), blockNumber: at.number.toString(), blockHash: at.hash };
  }
  async function provider(providerAddress) {
    const at = await snapshot(), p = await platform(at);
    const label = await read(at, p.registrar, registrarArtifact.abi, 'providerLabel', [providerAddress]);
    if (!label) return { ...p, provider: null };
    const owner = await state(at, p.registry, label);
    if (!sameAddress(owner.latestOwner, providerAddress)) throw new Error('Provider namespace owner has changed.');
    const [registry, resolver] = await Promise.all(['getSubregistry', 'getResolver'].map(fn => read(at, p.registry, registryAbi, fn, [label])));
    await Promise.all([provenance(at, registry, 'UserRegistryImpl'), provenance(at, resolver, 'PermissionedResolverImpl')]);
    return { ...p, provider: { name: `${label}.${root}`, address: providerAddress, registry, resolver, expiry: owner.expiry.toString() } };
  }
  async function describeName(value, at = undefined) {
    const name = strategyName(value, root), [label, providerLabel] = name.split('.');
    at ??= await snapshot();
    const p = await platform(at), owner = await state(at, p.registry, providerLabel);
    const child = await read(at, p.registry, registryAbi, 'getSubregistry', [providerLabel]);
    await provenance(at, child, 'UserRegistryImpl');
    const childState = await state(at, child, label);
    if (!sameAddress(owner.latestOwner, childState.latestOwner)) throw new Error('Strategy and Provider namespace owners differ.');
    const resolver = await client.getEnsResolver({ name, blockNumber: at.number });
    await provenance(at, resolver, 'PermissionedResolverImpl');
    return { name, node: namehash(name), provider: owner.latestOwner.toLowerCase(), registry: child, resolver,
      blockNumber: at.number.toString(), blockHash: at.hash, checkedAt: new Date(Number(at.timestamp) * 1000).toISOString(), at };
  }
  async function resolve(value) {
    const found = await describeName(value);
    const raw = await client.getEnsText({ name: found.name, key: RELEASE_KEY, blockNumber: found.at.number });
    if (!raw) throw new Error('This ENS name has no published strategy version.');
    const pointer = parseReleasePointer(raw);
    if (!sameAddress(pointer.provider, found.provider)) throw new Error('ENS record points to a different Provider.');
    const { at, ...result } = found;
    return { ...result, pointer };
  }
  async function delegation(name, delegate) {
    const found = await describeName(name), node = namehash(found.name);
    const parts = [textResource(node, RELEASE_KEY), textResource(node, ''), textResource('0x' + '00'.repeat(32), RELEASE_KEY)];
    // Name scope hashes node||bytes32(0), rather than the empty string's hash.
    parts[1] = BigInt(keccak256(node + '00'.repeat(32)));
    const grants = await Promise.all([read(found.at, found.resolver, resolverAbi, 'hasRootRoles', [SET_TEXT_ROLE, delegate]),
      ...parts.map(resource => read(found.at, found.resolver, resolverAbi, 'hasRoles', [resource, SET_TEXT_ROLE, delegate]))]);
    return { name: found.name, delegate, key: RELEASE_KEY, allowed: grants.some(Boolean), broaderAccess: grants[0] || grants[2] || grants[3], resolver: found.resolver };
  }
  return { client, rootName: root, platform, provider, describeName, resolve, delegation };
}
