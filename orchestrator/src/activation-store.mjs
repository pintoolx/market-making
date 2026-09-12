import { mkdir, readdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const activationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function activationStore(stateDir) {
  const root = join(stateDir, 'activations');
  const path = id => { if (!activationId.test(id)) throw new Error('Invalid activation ID'); return join(root, `${id}.json`); };
  return {
    async read(id) { return JSON.parse(await readFile(path(id), 'utf8')); },
    async insert(record) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = join(root, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      try { await link(temporary, path(record.id)); }
      finally { await unlink(temporary); }
    },
    async confirm(record) {
      const temporary = join(root, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path(record.id));
    },
    async confirmed() {
      let files;
      try { files = await readdir(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const records = await Promise.all(files.filter(f => activationId.test(f.slice(0, -5)) && f.endsWith('.json')).map(f => readFile(join(root, f), 'utf8').then(JSON.parse)));
      return records.filter(r => r.transactionHash);
    },
  };
}

export async function activationCatalog(stateDir) {
  const entries = {};
  for (const record of await activationStore(stateDir).confirmed()) {
    const id = `${record.plan.release.id}.v${record.plan.release.version}`;
    if (entries[id] && entries[id].strategyHash !== record.plan.strategyHash) throw new Error('Conflicting activated version');
    entries[id] = { ...record.plan.catalogEntry, maker: record.maker, shipTransaction: record.transactionHash };
  }
  return entries;
}

// Restore compiler-verified, chain-confirmed bindings after every deployment.
// The simulator owns this staging config; this never touches Chainlink credentials.
export async function syncActivationBindings(stateDir, configPath) {
  const records = await activationStore(stateDir).confirmed();
  if (!records.length) return;
  if (!configPath) throw new Error('Activation workflow configuration is unavailable');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const bindings = new Map((config.providerBindings ?? []).map(b => [b.strategyHash, b]));
  for (const record of records) {
    const binding = record.plan.workflowBinding;
    const previous = bindings.get(binding.strategyHash);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error('Conflicting workflow binding');
    bindings.set(binding.strategyHash, binding);
  }
  config.providerBindings = [...bindings.values()];
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, configPath);
}
