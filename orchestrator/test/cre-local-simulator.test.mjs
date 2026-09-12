import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { localSimulatorConfig, simulateCREWorkflow } from '../src/cre-local-simulator.mjs';

test('local simulator always runs the HTTP TEE handler with a Sepolia broadcast', async () => {
  const config = localSimulatorConfig({ CRE_PROJECT_DIR: '/workspace/workflow', CRE_CLI: '/usr/bin/cre', CRE_TARGET: 'staging-settings' });
  const payload = { requestId: 'mandate-1', maker: `0x${'11'.repeat(20)}`, strategyHash: `0x${'22'.repeat(32)}`, marketSnapshot: { midPrice: '2500' } };
  let invocation;
  const output = await simulateCREWorkflow(config, payload, { spawnImpl(executable, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const fileArg = args[args.indexOf('--http-payload') + 1];
    invocation = { executable, args, options, body: JSON.parse(readFileSync(fileArg.slice(1), 'utf8')) };
    queueMicrotask(() => { child.stdout.end('Workflow Simulation Result'); child.stderr.end(); child.emit('close', 0); });
    return child;
  } });
  assert.equal(invocation.executable, '/usr/bin/cre');
  assert.equal(invocation.options.cwd, '/workspace/workflow');
  assert.equal(invocation.options.shell, false);
  assert.ok(invocation.args.includes('--broadcast'));
  assert.ok(invocation.args.includes('--non-interactive'));
  assert.deepEqual(invocation.body, payload);
  assert.match(output.workflowExecutionId, /^local-simulation-/);
});

test('local simulator requires an absolute CRE project directory', () => {
  assert.throws(() => localSimulatorConfig({ CRE_PROJECT_DIR: 'workflow' }), /absolute path/);
});
