import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { invokeExecutionGateway, runnerConfig } from '../src/http-runner.mjs';

const config = { endpoint: new URL('https://execution.example/v1/run'), token: 'secret-token', timeoutMs: 1000 };

test('runner requires authenticated HTTPS except on localhost', () => {
  assert.equal(runnerConfig({ CONFIDENTIAL_EXECUTION_URL: 'https://execution.example/v1/run', CONFIDENTIAL_EXECUTION_TOKEN: 'token' }).endpoint.protocol, 'https:');
  assert.equal(runnerConfig({ CONFIDENTIAL_EXECUTION_URL: 'http://localhost:8788/run', CONFIDENTIAL_EXECUTION_TOKEN: 'token' }).endpoint.hostname, 'localhost');
  assert.throws(() => runnerConfig({ CONFIDENTIAL_EXECUTION_URL: 'http://execution.example/run', CONFIDENTIAL_EXECUTION_TOKEN: 'token' }), /HTTPS/);
  assert.throws(() => runnerConfig({ CONFIDENTIAL_EXECUTION_URL: 'https://execution.example/run' }), /TOKEN/);
});

test('runner forwards one private request and emits only the public gateway result', async () => {
  const request = { action: 'create', input: { policy: { maxSwapUsdc: '100' } } };
  const state = { mandateId: 'mandate-01', evidence: { reportTransactionHash: `0x${'a'.repeat(64)}` } };
  let observed;
  const result = await invokeExecutionGateway(request, config, async (url, init) => {
    observed = { url: String(url), method: init.method, authorization: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(observed, { url: String(config.endpoint), method: 'POST', authorization: 'Bearer secret-token', body: request });
  assert.deepEqual(result, state);
});

test('runner rejects gateway errors, invalid JSON and oversized responses', async () => {
  await assert.rejects(invokeExecutionGateway({}, config, async () => new Response('no', { status: 403 })), /rejected/);
  await assert.rejects(invokeExecutionGateway({}, config, async () => new Response('not-json')), /invalid JSON/);
  await assert.rejects(invokeExecutionGateway({}, config, async () => new Response('', { headers: { 'content-length': '2000001' } })), /exceeded limit/);
});

test('runner executable carries one stdin request to the gateway and returns one stdout document', async t => {
  const request = { action: 'create', input: { maker: '0x1111111111111111111111111111111111111111', policy: { maxSwapUsdc: '100' } } };
  const state = { mandateId: 'mandate-process', evidence: { reportTransactionHash: `0x${'b'.repeat(64)}` } };
  let received;
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', chunk => { body += chunk; });
    incoming.on('end', () => {
      received = { authorization: incoming.headers.authorization, body: JSON.parse(body) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const executable = fileURLToPath(new URL('../bin/confidential-http-runner', import.meta.url));
  const child = spawn(executable, [], { shell: false, env: {
    ...process.env,
    CONFIDENTIAL_EXECUTION_URL: `http://127.0.0.1:${address.port}/v1/run`,
    CONFIDENTIAL_EXECUTION_TOKEN: 'process-token',
  } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), state);
  assert.deepEqual(received, { authorization: 'Bearer process-token', body: request });
});
