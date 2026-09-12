import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256, toBytes, verifyMessage } from 'viem';
import { parseRelease, parseEnvelope, publicationMessage } from '../../shared/lp-release.mjs';

const validId = id => /^[0-9a-f]{40}-clmm$/.test(id);
export function createProviderRegistry(stateDir) {
  const root = join(stateDir, 'provider-releases');
  const read = async (id, version) => {
    if (!validId(id) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid release reference');
    return JSON.parse(await readFile(join(root, id, `${version}.json`), 'utf8'));
  };
  const latest = async id => {
    if (!validId(id)) throw new Error('Invalid release ID');
    let files;
    try { files = await readdir(join(root, id)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const versions = files.filter(f => /^[1-9][0-9]*\.json$/.test(f)).map(f => Number(f.slice(0, -5)));
    return versions.length ? read(id, Math.max(...versions)) : null;
  };
  const publicRecord = record => ({ ...record.release, digest: record.digest, executionStatus: 'requires-provisioning', revenueSharing: 'disabled' });
  return {
    read, latest,
    async list() {
      let ids;
      try { ids = await readdir(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return (await Promise.all(ids.filter(validId).map(latest))).filter(Boolean).map(publicRecord);
    },
    async publish(input) {
      if (!input || Object.keys(input).some(k => !['release', 'envelope', 'signature'].includes(k))) throw new Error('Invalid publication request');
      const release = parseRelease(input.release), envelope = parseEnvelope(input.envelope);
      const message = publicationMessage(release, envelope);
      if (typeof input.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(input.signature)
        || !await verifyMessage({ address: release.provider, message, signature: input.signature })) throw new Error('Provider signature is invalid');
      const digest = keccak256(toBytes(message));
      const current = await latest(release.id);
      // An exact retry returns the same immutable version, even after a later update.
      if (current && release.version <= current.release.version) {
        const previous = await read(release.id, release.version);
        if (previous.digest === digest) return publicRecord(previous);
        throw new Error('Version conflict; reload the current release');
      }
      if (release.version !== (current?.release.version ?? 0) + 1 || (!current && release.state === 'withdrawn')) throw new Error('Version conflict; reload the current release');
      const directory = join(root, release.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Republishing after a withdrawal must not revive approvals for older versions.
      const withdrawnThrough = release.state === 'withdrawn' ? release.version : (current?.withdrawnThrough ?? 0);
      const record = { release, envelope, signature: input.signature, digest, withdrawnThrough };
      // Write a complete temporary file then link atomically without replacing an existing version.
      const { randomUUID } = await import('node:crypto');
      const { link, unlink } = await import('node:fs/promises');
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
      try { await link(temporary, join(directory, `${release.version}.json`)); }
      catch (e) { if (e.code !== 'EEXIST') throw e; const winner = await read(release.id, release.version); if (winner.digest !== digest) throw new Error('Version conflict; reload the current release'); }
      finally { await unlink(temporary); }
      return publicRecord(record);
    },
  };
}
