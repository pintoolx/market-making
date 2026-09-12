import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import { createCRERequest, stableStringify, triggerCREWorkflow } from '../src/cre-gateway.mjs';

const privateKey = `0x${'11'.repeat(32)}`;
const workflowId = 'ab'.repeat(32);

test('stableStringify orders keys recursively for the CRE request digest', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 }, list: [{ z: 4, a: 5 }] }),
    '{"a":{"b":3,"y":2},"list":[{"a":5,"z":4}],"z":1}');
});

test('createCRERequest produces an official ETH JWT bound to the sorted body', async () => {
  const signed = await createCRERequest({
    workflowId,
    privateKey,
    input: { maker: '0x1111111111111111111111111111111111111111', requestId: 'mandate-1' },
    requestId: 'rpc-1',
    nowSec: 1_700_000_000,
    jwtId: 'jwt-1',
  });
  const [header, payload, signature] = signed.token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ETH', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    digest: `0x${createHash('sha256').update(signed.body).digest('hex')}`,
    iss: signed.signer,
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    jti: 'jwt-1',
  });
  const bytes = Buffer.from(signature, 'base64url');
  const ethereumSignature = `0x${bytes.subarray(0, 64).toString('hex')}${(bytes[64] + 27).toString(16).padStart(2, '0')}`;
  assert.equal((await recoverMessageAddress({ message: `${header}.${payload}`, signature: ethereumSignature })).toLowerCase(), signed.signer.toLowerCase());
  assert.deepEqual(JSON.parse(signed.body), {
    id: 'rpc-1',
    jsonrpc: '2.0',
    method: 'workflows.execute',
    params: {
      input: { maker: '0x1111111111111111111111111111111111111111', requestId: 'mandate-1' },
      workflow: { workflowID: workflowId },
    },
  });
});

test('triggerCREWorkflow accepts only a correlated gateway acceptance', async () => {
  let observed;
  const accepted = await triggerCREWorkflow({ gatewayUrl: 'https://01.gateway.zone-a.cre.chain.link', workflowId, privateKey }, { requestId: 'mandate-1' }, {
    requestId: 'rpc-2',
    nowSec: 1_700_000_000,
    jwtId: 'jwt-2',
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 'rpc-2',
        result: { workflow_execution_id: 'execution-1', status: 'ACCEPTED' },
      }));
    },
  });
  assert.equal(observed.url, 'https://01.gateway.zone-a.cre.chain.link');
  assert.match(observed.init.headers.authorization, /^Bearer /);
  assert.deepEqual(accepted, { requestId: 'rpc-2', workflowExecutionId: 'execution-1', status: 'ACCEPTED' });

  await assert.rejects(triggerCREWorkflow({ gatewayUrl: 'https://gateway.example', workflowId, privateKey }, {}, {
    requestId: 'rpc-3',
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: { status: 'ACCEPTED', workflow_execution_id: 'x' } })),
  }), /invalid acceptance/);
});
