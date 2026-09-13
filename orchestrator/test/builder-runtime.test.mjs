import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuilderRuntime } from '../src/builder-runtime.mjs';

test('Builder runtime stays disabled when the deployment has no database', async () => {
  const runtime = await createBuilderRuntime({}, { BUILDER_ENABLED: 'false' });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.handler, undefined);
  await runtime.start();
  await runtime.close();
});

test('Builder runtime requires a database when explicitly enabled', async () => {
  await assert.rejects(
    createBuilderRuntime({}, { BUILDER_ENABLED: 'true' }),
    /DATABASE_URL is required when BUILDER_ENABLED=true/,
  );
});
