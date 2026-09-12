#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 2_000_000;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function runnerConfig(env = process.env) {
  const endpoint = new URL(required(env, 'CONFIDENTIAL_EXECUTION_URL'));
  const local = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '::1';
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) {
    throw new Error('CONFIDENTIAL_EXECUTION_URL must use HTTPS outside localhost');
  }
  const timeoutMs = Number(env.CONFIDENTIAL_EXECUTION_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error('CONFIDENTIAL_EXECUTION_TIMEOUT_MS must be between 1000 and 600000');
  }
  return { endpoint, token: required(env, 'CONFIDENTIAL_EXECUTION_TOKEN'), timeoutMs };
}

export async function invokeExecutionGateway(request, config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`confidential execution gateway rejected the request (${response.status})`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_OUTPUT_BYTES) throw new Error('confidential execution gateway response exceeded limit');
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_OUTPUT_BYTES) throw new Error('confidential execution gateway response exceeded limit');
    try { return JSON.parse(body); }
    catch { throw new Error('confidential execution gateway returned invalid JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

async function readInput(stream = process.stdin) {
  let body = '';
  for await (const chunk of stream) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('runner input exceeded limit');
  }
  try { return JSON.parse(body); }
  catch { throw new Error('runner input is not valid JSON'); }
}

export async function main() {
  const request = await readInput();
  const result = await invokeExecutionGateway(request, runnerConfig());
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    // Never include the request, response body, token or nested provider error.
    process.stderr.write(`${error instanceof Error ? error.message : 'confidential runner failed'}\n`);
    process.exitCode = 1;
  });
}
