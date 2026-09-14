// Public synthetic Provider policy and encryption key; no wallet or broadcast.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519';
import { keccak256, stringToHex } from 'viem';
import { sealProviderStrategy } from '../../frontend/src/app/marketplace/confidentialEnvelope.ts';
import { createCreSimulator } from '../../orchestrator/src/builder-cre-simulator.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../market-maker-auth/config.staging.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../fixtures/public-live-demo.json', import.meta.url), 'utf8'));
const key = new Uint8Array(32).fill(7); // PUBLIC encryption fixture, never a funded key.
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const provider = '0x7777777777777777777777777777777777777777';
const providerStrategyEnvelope = sealProviderStrategy(fixture.strategy, hex(x25519.getPublicKey(key)), provider);
Object.assign(config, { publishMode: 'dry-run', marketSource: 'fixture', builderSimulation: true,
  marketSnapshot: { midPrice: '2500', volatilityBps: 0, balance0: '0', balance1: '0', decimals0: 18, decimals1: 6 },
  builderEnvelope: { maxAmount0PerSwap: '1000000000000000', maxAmount1PerSwap: '2500000', maxPostBalance0: '10000000000000000', maxPostBalance1: '25000000' },
  providerBindings: [{ provider, strategyId: fixture.strategy.strategyId, strategyHash: config.strategyHash,
    envelopeHash: keccak256(stringToHex(JSON.stringify(providerStrategyEnvelope))) }],
});
const env = { ...process.env, TZ: 'UTC', SECRET_ENVELOPE_PRIVATE_KEY: hex(key), SECRET_PROVIDER_STRATEGY: JSON.stringify(fixture.strategy),
  SECRET_PROVIDER_STRATEGY_DEFENSIVE: JSON.stringify(fixture.strategy), SECRET_MAKER_LIMITS: JSON.stringify(fixture.limits) };
delete env.CRE_ETH_PRIVATE_KEY;
const simulate = createCreSimulator({ projectDirectory: root, env, timeoutMs: 120000, broadcastEnabled: false });
const result = await simulate({ config, payload: { requestId: 'builder-public-cli-v1', maker: config.maker, strategyHash: config.strategyHash,
  provider, providerStrategyEnvelope, marketSnapshot: config.marketSnapshot, builder: { phase: 'evaluate' } } });
console.log(JSON.stringify(result, null, 2));
