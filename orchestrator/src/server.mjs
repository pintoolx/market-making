import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createService, HttpError } from './service.mjs';
import { createProviderRegistry } from './provider-registry.mjs';
import { LP_CAPABILITIES } from '../../shared/lp-release.mjs';

const integer = (value, fallback) => value === undefined ? fallback : Number(value);

function strategyCatalog(value) {
  let parsed;
  try { parsed = JSON.parse(value ?? '{}'); } catch { throw new Error('MANDATE_STRATEGY_CATALOG must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MANDATE_STRATEGY_CATALOG must be an object');
  return Object.entries(parsed).map(([id, item]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) || !item || typeof item !== 'object'
      || typeof item.name !== 'string' || !item.name.trim() || typeof item.provider !== 'string' || !item.provider.trim()
      || !/^0x[0-9a-f]{64}$/i.test(item.strategyHash ?? '')) throw new Error('MANDATE_STRATEGY_CATALOG contains an invalid strategy');
    if (item.programDeadline !== undefined && (!Number.isSafeInteger(item.programDeadline) || item.programDeadline < 1)) throw new Error('Invalid program deadline');
    if (item.release !== undefined && (!item.release || Object.keys(item.release).some(k => !['id', 'version', 'digest'].includes(k))
      || !/^[0-9a-f]{40}-clmm$/.test(item.release.id ?? '') || !Number.isSafeInteger(item.release.version) || item.release.version < 1
      || !/^0x[0-9a-f]{64}$/i.test(item.release.digest ?? '') || id !== `${item.release.id}.v${item.release.version}`)) throw new Error('Invalid publication binding');
    return { id, name: item.name, provider: item.provider, strategyHash: item.strategyHash.toLowerCase(),
      ...(item.programDeadline !== undefined ? { programDeadline: item.programDeadline } : {}),
      ...(item.release !== undefined ? { release: item.release } : {}) };
  });
}

export function configFromEnv(env = process.env) {
  const config = {
    port: integer(env.PORT, 8787),
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'http://localhost:3200',
    runner: env.MANDATE_RUNNER,
    runnerTimeoutMs: integer(env.MANDATE_RUNNER_TIMEOUT_MS, 120000),
    chainId: integer(env.MANDATE_CHAIN_ID, 11155111),
    networkName: env.MANDATE_NETWORK_NAME ?? 'Ethereum Sepolia',
    rpcUrl: env.MANDATE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: (env.MANDATE_EXPLORER_URL ?? 'https://sepolia.etherscan.io').replace(/\/$/, ''),
    router: env.MANDATE_ROUTER_ADDRESS,
    guard: env.MANDATE_GUARD_ADDRESS,
    aqua: env.MANDATE_AQUA_ADDRESS,
    strategies: strategyCatalog(env.MANDATE_STRATEGY_CATALOG),
    strategyMaker: env.MANDATE_STRATEGY_MAKER?.toLowerCase(),
    stateDir: env.MANDATE_STATE_DIR ?? '.state/mandates',
  };
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('invalid PORT');
  if (!Number.isSafeInteger(config.chainId) || config.chainId < 1) throw new Error('invalid MANDATE_CHAIN_ID');
  if (!config.runner) throw new Error('MANDATE_RUNNER is required; the service will not fabricate mandate evidence');
  if (!/^0x[0-9a-f]{40}$/i.test(config.router ?? '')) throw new Error('MANDATE_ROUTER_ADDRESS is required');
  if (!/^0x[0-9a-f]{40}$/i.test(config.strategyMaker ?? '')) throw new Error('MANDATE_STRATEGY_MAKER is required');
  return config;
}

const readJson = request => new Promise((resolve, reject) => {
  let data = '';
  request.on('data', chunk => {
    data += chunk;
    if (data.length > 64_000) { reject(new HttpError(413, 'Request is too large.')); request.destroy(); }
  });
  request.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new HttpError(400, 'Request body must be JSON.')); } });
  request.on('error', reject);
});

export function makeServer(config, dependencies) {
  const service = createService(config, dependencies);
  const registry = createProviderRegistry(config.stateDir);
  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    if (request.headers.origin && request.headers.origin !== config.allowedOrigin) {
      response.writeHead(403, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ message: 'Origin is not allowed.' }));
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const releaseVersion = url.pathname.match(/^\/v1\/provider-strategies\/([0-9a-f]{40}-clmm)\/versions\/([1-9][0-9]{0,6})$/);
      if (request.method === 'GET' && releaseVersion) {
        let record;
        try { record = await registry.read(releaseVersion[1], Number(releaseVersion[2])); } catch { throw new HttpError(404, 'Release version not found.'); }
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ ...record.release, digest: record.digest }));
      }
      if (request.method === 'GET' && url.pathname === '/v1/lp-capabilities') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(LP_CAPABILITIES));
      }
      if (url.pathname === '/v1/provider-strategies') {
        let result;
        if (request.method === 'GET') result = { strategies: await registry.list() };
        else if (request.method === 'POST') {
          const body = await readJson(request);
          try { result = await registry.publish(body); }
          catch { throw new HttpError(400, 'Publication failed. Check the signature and reload the latest version before retrying.'); }
        } else throw new HttpError(405, 'Method not allowed.');
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(result));
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ status: 'ok', chainId: config.chainId, network: config.networkName }));
      }
      if (request.method === 'GET' && url.pathname === '/v1/strategies') {
        const available = [];
        for (const item of config.strategies) {
          if (item.release) {
            try {
              const [record, latest] = await Promise.all([registry.read(item.release.id, item.release.version), registry.latest(item.release.id)]);
              if (record.digest !== item.release.digest || record.release.state !== 'published' || latest?.release.state !== 'published'
                || item.release.version <= (latest.withdrawnThrough ?? 0)) continue;
            } catch { continue; }
          }
          available.push(item);
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ maker: config.strategyMaker, strategies: available }));
      }
      let result;
      if (request.method === 'POST' && url.pathname === '/v1/mandates') result = await service.create(await readJson(request));
      else {
        const match = url.pathname.match(/^\/v1\/mandates\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})(\/(strategies|executions))?$/);
        if (!match) throw new HttpError(404, 'Route not found.');
        result = request.method === 'GET' && !match[2] ? await service.get(match[1])
          : request.method === 'POST' && match[3] === 'strategies' ? await service.add(match[1], await readJson(request))
            : request.method === 'POST' && match[3] === 'executions' ? await service.recordExecution(match[1], await readJson(request))
            : (() => { throw new HttpError(405, 'Method not allowed.'); })();
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : 'Mandate execution or evidence verification failed.';
      if (!(error instanceof HttpError)) console.error(error instanceof Error ? error.message : error);
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = configFromEnv();
  makeServer(config).listen(config.port, () => console.log(`PinTool mandate service listening on :${config.port}`));
}
