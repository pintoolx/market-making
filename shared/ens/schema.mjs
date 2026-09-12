import { keccak256, toBytes } from 'viem';
import { normalize, namehash } from 'viem/ens';
import { parseRelease } from '../lp-release.mjs';

export const ENS_CHAIN_ID = 11155111;
export const RELEASE_KEY = 'fun.pintool.release';
export const REGISTRAR_KEY = 'fun.pintool.registrar';
export const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
export const SET_TEXT_ROLE = 1n << 4n;
export const NAME_ROLES = (1n << 16n) | (1n << 20n) | (1n << 24n);
const address = /^0x[0-9a-f]{40}$/i, hash = /^0x[0-9a-f]{64}$/i;
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Invalid ENS record fields.');
};
export function normalizeRoot(value) {
  const name = normalize(String(value).trim());
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\.eth$/.test(name)) throw new Error('Use a 3–32 character .eth platform name.');
  return name;
}
export function normalizeLabel(value) {
  const label = normalize(String(value).trim());
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(label)) throw new Error('Use 3–32 lowercase letters, numbers or hyphens.');
  return label;
}
export function strategyName(value, root) {
  const name = normalize(String(value).trim()), suffix = normalizeRoot(root);
  const labels = name.split('.');
  if (labels.length !== 4 || labels.slice(2).join('.') !== suffix) throw new Error(`Choose a strategy under provider.${suffix}.`);
  normalizeLabel(labels[0]); normalizeLabel(labels[1]);
  return name;
}
export function parseReleasePointer(value) {
  if (typeof value === 'string') { if (value.length > 1024) throw new Error('ENS record is too large.'); try { value = JSON.parse(value); } catch { throw new Error('ENS strategy record is invalid JSON.'); } }
  exact(value, ['schema', 'chainId', 'provider', 'releaseId', 'version', 'publicationDigest']);
  if (value.schema !== 'pintool-ens-release-v1' || value.chainId !== ENS_CHAIN_ID || !address.test(value.provider ?? '')
    || !/^[0-9a-f]{40}-clmm$/.test(value.releaseId ?? '') || value.releaseId !== `${value.provider.toLowerCase().slice(2)}-clmm`
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 1000000 || !hash.test(value.publicationDigest ?? '')) throw new Error('ENS strategy reference is invalid.');
  return { schema: value.schema, chainId: ENS_CHAIN_ID, provider: value.provider.toLowerCase(), releaseId: value.releaseId,
    version: value.version, publicationDigest: value.publicationDigest.toLowerCase() };
}
export function releasePointer(release, digest) {
  return parseReleasePointer({ schema: 'pintool-ens-release-v1', chainId: ENS_CHAIN_ID, provider: release.provider,
    releaseId: release.id, version: release.version, publicationDigest: digest });
}
export function parseSelection(value, root) {
  exact(value, ['name', 'node', 'pointer']);
  const name = strategyName(value.name, root);
  if (value.node !== namehash(name)) throw new Error('ENS name and namehash differ.');
  return { name, node: value.node, pointer: parseReleasePointer(value.pointer) };
}
export function publicReleaseHash(release) {
  const { schema, id, version, provider, name, summary, state, execution } = release;
  return keccak256(toBytes(JSON.stringify(parseRelease({ schema, id, version, provider, name, summary, state, execution }))));
}
// Separately signed public manifest: never publish the ciphertext-bearing publication message.
export function manifestMessage(name, root, release, digest) {
  return 'PinTool ENS public manifest v1\n' + JSON.stringify({ name: strategyName(name, root),
    pointer: releasePointer(release, digest), publicReleaseHash: publicReleaseHash(release) });
}
export function textResource(node, key) { return BigInt(keccak256(node + keccak256(toBytes(key)).slice(2))); }
