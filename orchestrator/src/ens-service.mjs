import { mkdir, readdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { keccak256, toBytes, verifyMessage } from 'viem';
import { namehash } from 'viem/ens';
import { createEnsReader, sameAddress } from '../../shared/ens/chain.mjs';
import { normalizeRoot, strategyName, manifestMessage, parseSelection, releasePointer } from '../../shared/ens/schema.mjs';
import { publicationMessage } from '../../shared/lp-release.mjs';
import { activationCatalog } from './activation-store.mjs';

export function createEnsService(config, registry, dependencies = {}) {
  const rootName = normalizeRoot(config.ensRootName ?? 'pintool.eth');
  const reader = dependencies.ensReader ?? createEnsReader({ rootName, rpcUrl: config.ensRpcUrl ?? config.rpcUrl });
  const directory = join(config.stateDir, 'ens-manifests');
  const file = (name, digest) => join(directory, `${namehash(name)}-${digest}.json`);
  async function publication(id, version, digest) {
    const [record, latest] = await Promise.all([registry.read(id, version), registry.latest(id)]);
    const message = publicationMessage(record.release, record.envelope);
    if (record.release.state !== 'published' || latest?.release.state !== 'published' || version <= (latest.withdrawnThrough ?? 0)) throw new Error('This strategy version has been withdrawn.');
    if (record.digest !== digest || keccak256(toBytes(message)) !== digest || !await verifyMessage({ address: record.release.provider, message, signature: record.signature })) throw new Error('The stored publication does not match its signature or digest.');
    return record;
  }
  const publicManifest = record => ({ name: record.name, pointer: releasePointer(record.release, record.digest), release: record.release, signature: record.signature });
  async function manifest(name, pointer) {
    let saved;
    try { saved = JSON.parse(await readFile(file(name, pointer.publicationDigest), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new Error('Approve this strategy revision for the ENS name before publishing the link.');
      throw error;
    }
    if (saved.name !== name || JSON.stringify(releasePointer(saved.release, saved.digest)) !== JSON.stringify(pointer)
      || !await verifyMessage({ address: pointer.provider, message: manifestMessage(name, rootName, saved.release, saved.digest), signature: saved.signature })) throw new Error('The public ENS manifest is invalid.');
    return saved;
  }
  return {
    reader, rootName,
    async names(providerAddress) {
      let paths;
      try { paths = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return { names: [] }; throw e; }
      const names = new Set();
      for (const path of paths.filter(p => /^0x[0-9a-f]{64}-0x[0-9a-f]{64}\.json$/.test(p))) {
        const record = JSON.parse(await readFile(join(directory, path), 'utf8'));
        if ((!providerAddress || sameAddress(record.release?.provider, providerAddress)) && strategyName(record.name, rootName)) names.add(record.name);
      }
      const results = [];
      // Onchain records remain the source of truth. A failed lookup is visibly unverified.
      for (const name of [...names].sort()) {
        try { const resolved = await this.resolve(name); results.push({ name, pointer: resolved.pointer, verified: true }); }
        catch { results.push({ name, verified: false }); }
      }
      return { names: results };
    },
    async status(provider) {
      const platform = provider ? await reader.provider(provider) : await reader.platform();
      return { chainId: 11155111, ...platform };
    },
    async saveManifest(input) {
      if (!input || Object.keys(input).some(k => !['name', 'releaseId', 'version', 'publicationDigest', 'signature'].includes(k))) throw new Error('Invalid public manifest request.');
      const name = strategyName(input.name, rootName);
      if (!/^0x[0-9a-f]{64}$/i.test(input.publicationDigest ?? '') || !/^0x[0-9a-f]{130}$/i.test(input.signature ?? '')) throw new Error('Manifest signature or digest is invalid.');
      const saved = await publication(input.releaseId, input.version, input.publicationDigest);
      if (!await verifyMessage({ address: saved.release.provider, message: manifestMessage(name, rootName, saved.release, saved.digest), signature: input.signature })) throw new Error('Only the Provider can approve this ENS manifest.');
      const ownership = await reader.describeName(name);
      if (!sameAddress(ownership.provider, saved.release.provider)) throw new Error('The connected Provider does not own this strategy namespace.');
      const record = { name, release: saved.release, digest: saved.digest, signature: input.signature };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
      try { await link(temporary, file(name, saved.digest)); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const previous = await manifest(name, releasePointer(saved.release, saved.digest));
        if (manifestMessage(name, rootName, previous.release, previous.digest) !== manifestMessage(name, rootName, record.release, record.digest)) throw new Error('ENS manifest conflict.');
      } finally { await unlink(temporary); }
      return publicManifest(record);
    },
    async approvedManifest(name, id, version) {
      name = strategyName(name, rootName);
      const saved = await registry.read(id, version);
      await publication(id, version, saved.digest);
      const record = await manifest(name, releasePointer(saved.release, saved.digest));
      const current = await reader.describeName(name);
      if (!sameAddress(current.provider, saved.release.provider)) throw new Error('ENS ownership changed.');
      return publicManifest(record);
    },
    async latestApproved(name) {
      name = strategyName(name, rootName);
      const owner = await reader.describeName(name);
      const latest = await registry.latest(`${owner.provider.slice(2)}-clmm`);
      if (!latest) throw new Error('Provider has not published a version.');
      // No automatic fallback to an old version after a withdrawal or a missing approval.
      return this.approvedManifest(name, latest.release.id, latest.release.version);
    },
    async resolve(value) {
      const name = strategyName(value, rootName), resolved = await reader.resolve(name);
      await publication(resolved.pointer.releaseId, resolved.pointer.version, resolved.pointer.publicationDigest);
      const saved = await manifest(name, resolved.pointer);
      return { ...resolved, manifest: publicManifest(saved) };
    },
    async validateSelections(selections, ids, maker) {
      if (selections === undefined) return [];
      if (!Array.isArray(selections) || selections.length > 12) throw new Error('Invalid ENS selections.');
      const result = [], seen = new Set();
      for (const input of selections) {
        const selection = parseSelection(input, rootName), p = selection.pointer, id = `${p.releaseId}.v${p.version}`;
        if (!ids.includes(id) || seen.has(id)) throw new Error('ENS selection differs from the selected strategy.');
        seen.add(id);
        const current = await this.resolve(selection.name);
        if (JSON.stringify(current.pointer) !== JSON.stringify(p)) throw new Error('The ENS strategy changed. Resolve it again and review the new version.');
        const activated = config.stateDir ? (await activationCatalog(config.stateDir))[id] : undefined;
        const provisioned = activated && sameAddress(activated.maker, maker) ? activated : config.strategies?.find(item => item.id === id);
        if (!provisioned?.release || provisioned.release.digest !== p.publicationDigest || !sameAddress(config.strategyMaker, maker)) throw new Error('This exact ENS version is not provisioned for the Maker wallet.');
        result.push({ ...selection, verifiedBlock: current.blockNumber, verifiedBlockHash: current.blockHash });
      }
      return result;
    },
  };
}
