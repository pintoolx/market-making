import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createService, HttpError } from './service.mjs';

const integer = (value, fallback) => value === undefined ? fallback : Number(value);

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
    stateDir: env.MANDATE_STATE_DIR ?? '.state/mandates',
  };
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('invalid PORT');
  if (!Number.isSafeInteger(config.chainId) || config.chainId < 1) throw new Error('invalid MANDATE_CHAIN_ID');
  if (!config.runner) throw new Error('MANDATE_RUNNER is required; the service will not fabricate mandate evidence');
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
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ status: 'ok', chainId: config.chainId, network: config.networkName }));
      }
      let result;
      if (request.method === 'POST' && url.pathname === '/v1/mandates') result = await service.create(await readJson(request));
      else {
        const match = url.pathname.match(/^\/v1\/mandates\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})(\/strategies)?$/);
        if (!match) throw new HttpError(404, 'Route not found.');
        result = request.method === 'GET' && !match[2] ? await service.get(match[1])
          : request.method === 'POST' && match[2] ? await service.add(match[1], await readJson(request))
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
