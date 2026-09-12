import { verifyMessage } from 'viem';
import { createEnsReader } from '../../shared/ens/chain.mjs';
import { ensTransactions } from '../../shared/ens/transactions.mjs';
import { manifestMessage, parseReleasePointer, strategyName } from '../../shared/ens/schema.mjs';
import { parseRelease } from '../../shared/lp-release.mjs';

export function createEnsPublisher({ rootName, names, client, wallet, apiUrl, fetchImpl = fetch, onProgress = () => {} }) {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Publisher API must use HTTPS outside localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid publisher API URL.');
  const allowlist = names.map(n => strategyName(n, rootName));
  if (!allowlist.length || allowlist.length > 12 || new Set(allowlist).size !== allowlist.length) throw new Error('Configure 1–12 distinct strategy names for this publisher.');
  const reader = createEnsReader({ rootName, client }), tx = ensTransactions(client, wallet, onProgress);
  let running = false;
  async function approved(name) {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v1/ens/latest-approved?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('No active, approved version is available.');
    const raw = await response.text();
    if (raw.length > 20_000) throw new Error('Public manifest is too large.');
    const manifest = JSON.parse(raw), p = parseReleasePointer(manifest.pointer);
    parseRelease(manifest.release);
    if (manifest.name !== name || manifest.release.id !== p.releaseId || manifest.release.version !== p.version || manifest.release.state !== 'published'
      || manifest.release.provider.toLowerCase() !== p.provider || !await verifyMessage({ address: p.provider, message: manifestMessage(name, rootName, manifest.release, p.publicationDigest), signature: manifest.signature })) throw new Error('Provider approval is invalid.');
    return p;
  }
  return {
    async tick() {
      if (running) return [];
      running = true;
      const results = [];
      try {
        for (const name of allowlist) {
          try {
            const pointer = await approved(name);
            const grant = await reader.delegation(name, wallet.account.address ?? wallet.account);
            if (!grant.allowed) { results.push({ name, status: 'permission-revoked' }); continue; }
            let current;
            try { current = await reader.resolve(name); }
            catch (e) { if (e.message !== 'This ENS name has no published strategy version.') throw e; }
            if (current && JSON.stringify(current.pointer) === JSON.stringify(pointer)) { results.push({ name, status: 'up-to-date' }); continue; }
            if (current && current.pointer.version > pointer.version) throw new Error('Refusing to roll back the published ENS version.');
            if (JSON.stringify(await approved(name)) !== JSON.stringify(pointer)) throw new Error('Approval changed while preparing the update.');
            await tx.publishPointer(rootName, name, pointer);
            results.push({ name, status: 'published', version: pointer.version });
          } catch { results.push({ name, status: 'verification-or-delivery-failed' }); }
        }
        return results;
      } finally { running = false; }
    },
  };
}
