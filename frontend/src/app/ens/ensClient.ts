import { createPublicClient, http, verifyMessage, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { manifestMessage, parseReleasePointer, strategyName, type EnsSelection, type ReleasePointer } from '../../../../shared/ens/schema.mjs';
import { createEnsReader, type ResolvedName, type EnsPlatform, type EnsProvider } from '../../../../shared/ens/chain.mjs';
import { parseRelease, type LpRelease } from '../../../../shared/lp-release.mjs';
import { request } from '../marketplace/mandateClient';

export type PublicManifest = { name: string; pointer: ReleasePointer; release: LpRelease; signature: `0x${string}` };
export type EnsResolution = ResolvedName & { manifest: PublicManifest };
export type EnsStatus = EnsPlatform & { provider?: EnsProvider | null };
export const ensClient = createPublicClient({ chain: sepolia, transport: http(process.env.NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', { timeout: 15_000, retryCount: 1 }) });
export const getEnsConfig = () => request<{ rootName: string; chainId: number }>('/v1/ens/config');
export const getEnsStatus = (provider?: string) => request<EnsStatus>('/v1/ens/status' + (provider ? `?provider=${encodeURIComponent(provider)}` : ''));
export function ensError(reason: unknown): string {
  if (!(reason instanceof Error)) return 'ENS action failed. Check your Sepolia connection and retry.';
  if (/EACUnauthorized|permission-revoked/.test(reason.message)) return 'This wallet is not authorized to update that record. Ask the Provider to check its publisher permission.';
  if (/historical state|failed to get account|HTTP request failed|timed out/.test(reason.message)) return 'Sepolia data is unavailable from the current RPC. Your completed steps are preserved; retry with a working Sepolia connection.';
  if (/User rejected|User denied/.test(reason.message)) return 'The wallet request was declined. You can retry when ready.';
  return ('shortMessage' in reason && typeof reason.shortMessage === 'string' ? reason.shortMessage : reason.message).slice(0, 500);
}

export async function verifyManifest(manifest: PublicManifest, root: string) {
  parseRelease(manifest.release);
  const name = strategyName(manifest.name, root), p = parseReleasePointer(manifest.pointer);
  if (manifest.release.id !== p.releaseId || manifest.release.version !== p.version || manifest.release.provider.toLowerCase() !== p.provider
    || !await verifyMessage({ address: p.provider as Address, message: manifestMessage(name, root, manifest.release, p.publicationDigest), signature: manifest.signature })) throw new Error('Public strategy manifest signature is invalid.');
  return manifest;
}

export async function resolveEnsStrategy(input: string): Promise<EnsResolution> {
  const { rootName } = await getEnsConfig(), name = strategyName(input, rootName);
  const result = await request<EnsResolution>(`/v1/ens/resolve?name=${encodeURIComponent(name)}`);
  await verifyManifest(result.manifest, rootName);
  // Browser verifies canonical ENS independently of the API's public projection.
  const onchain = await createEnsReader({ rootName, client: ensClient }).resolve(name);
  if (JSON.stringify(onchain.pointer) !== JSON.stringify(parseReleasePointer(result.pointer))
    || JSON.stringify(onchain.pointer) !== JSON.stringify(parseReleasePointer(result.manifest.pointer))) throw new Error('ENS changed while loading. Resolve the name again.');
  return { ...result, ...onchain };
}

export const selectionFrom = (resolved: EnsResolution): EnsSelection => ({ name: resolved.name, node: resolved.node, pointer: resolved.pointer });
