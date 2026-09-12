import { createHash, randomUUID } from 'node:crypto';
import { parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WORKFLOW_ID = /^[0-9a-f]{64}$/i;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/i;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export async function createCRERequest({ workflowId, privateKey, input, requestId = randomUUID(), nowSec = Math.floor(Date.now() / 1000), jwtId = randomUUID() }) {
  if (!WORKFLOW_ID.test(workflowId)) throw new Error('CRE workflow ID must be 64 hexadecimal characters without a 0x prefix');
  if (!PRIVATE_KEY.test(privateKey)) throw new Error('CRE HTTP trigger private key is invalid');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CRE HTTP trigger input must be an object');

  const request = {
    id: requestId,
    jsonrpc: '2.0',
    method: 'workflows.execute',
    params: { input, workflow: { workflowID: workflowId } },
  };
  const body = stableStringify(request);
  const account = privateKeyToAccount(privateKey);
  const header = base64url(JSON.stringify({ alg: 'ETH', typ: 'JWT' }));
  const digest = `0x${createHash('sha256').update(body).digest('hex')}`;
  const payload = base64url(JSON.stringify({
    digest,
    iss: account.address,
    iat: nowSec,
    exp: nowSec + 300,
    jti: jwtId,
  }));
  const message = `${header}.${payload}`;
  const parsed = parseSignature(await account.signMessage({ message }));
  const recoveryId = parsed.v !== undefined ? (parsed.v >= 27n ? parsed.v - 27n : parsed.v) : parsed.yParity;
  if (recoveryId === undefined) throw new Error('CRE JWT signature has no recovery ID');
  const signature = Buffer.concat([
    Buffer.from(parsed.r.slice(2).padStart(64, '0'), 'hex'),
    Buffer.from(parsed.s.slice(2).padStart(64, '0'), 'hex'),
    Buffer.from([Number(recoveryId)]),
  ]).toString('base64url');
  return { body, token: `${message}.${signature}`, requestId, signer: account.address };
}

export async function triggerCREWorkflow(config, input, options = {}) {
  const signed = await createCRERequest({
    workflowId: config.workflowId,
    privateKey: config.privateKey,
    input,
    requestId: options.requestId,
    nowSec: options.nowSec,
    jwtId: options.jwtId,
  });
  const response = await (options.fetchImpl ?? fetch)(config.gatewayUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signed.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: signed.body,
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new Error(`CRE gateway rejected the workflow trigger (${response.status})`);
  if (payload?.id !== signed.requestId || payload?.jsonrpc !== '2.0'
    || payload?.result?.status !== 'ACCEPTED' || typeof payload?.result?.workflow_execution_id !== 'string') {
    throw new Error('CRE gateway returned an invalid acceptance response');
  }
  return {
    requestId: signed.requestId,
    workflowExecutionId: payload.result.workflow_execution_id,
    status: payload.result.status,
  };
}
