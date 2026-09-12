// Explicitly PUBLIC test inputs. No real policy, broadcast, deployment or secret upload.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519';
import { keccak256, stringToHex } from 'viem';
import { sealForConfidentialWorkflow, sealProviderStrategy } from '../../frontend/src/app/marketplace/confidentialEnvelope.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) throw new Error('Usage: node scripts/simulate-public-publication.mjs <public-config.json>');
const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../fixtures/public-live-demo.json', import.meta.url), 'utf8'));
const key = new Uint8Array(32).fill(7); // Public test key, never a funded wallet or production secret.
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const publicKey = hex(x25519.getPublicKey(key));
const provider = '0x7777777777777777777777777777777777777777';
fixture.strategy.strategyId = `${provider.slice(2)}-clmm.v1`;
const providerStrategyEnvelope = sealProviderStrategy(fixture.strategy, publicKey, provider);
const makerLimitsEnvelope = sealForConfidentialWorkflow(fixture.limits, publicKey, config.maker);
config.publishMode = 'dry-run'; config.marketSource = 'kraken'; delete config.marketSnapshot;
config.providerBindings = [{ provider, strategyId: fixture.strategy.strategyId, strategyHash: config.strategyHash,
  envelopeHash: keccak256(stringToHex(JSON.stringify(providerStrategyEnvelope))) }];
const directory = await mkdtemp(join(tmpdir(), 'pintool-public-publication-'));
try {
  const configFile = join(directory, 'config.json'), payloadFile = join(directory, 'request.json');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(payloadFile, JSON.stringify({ requestId: 'public-publication-v1', maker: config.maker, strategyHash: config.strategyHash,
    provider, providerStrategyEnvelope, makerLimitsEnvelope }));
  const env = { ...process.env, TZ: 'UTC', SECRET_ENVELOPE_PRIVATE_KEY: hex(key), SECRET_PROVIDER_STRATEGY: JSON.stringify(fixture.strategy),
    SECRET_PROVIDER_STRATEGY_DEFENSIVE: JSON.stringify(fixture.strategy), SECRET_MAKER_LIMITS: JSON.stringify(fixture.limits) };
  delete env.CRE_ETH_PRIVATE_KEY;
  const child = spawn('cre', ['workflow', 'simulate', 'market-maker-auth', '--target', 'staging-settings', '--non-interactive',
    '--trigger-index', '1', '--config', configFile, '--http-payload', payloadFile, '--env', '/dev/null'], { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
  process.exitCode = code ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
