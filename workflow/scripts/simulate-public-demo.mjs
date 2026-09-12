// Host-only launcher. The CRE CLI consumes synthetic policy inputs through its
// normal secret API. This does not load, inspect or print real Provider policies.
// For an authorized broadcast, the parent process supplies the existing signer
// opaquely. No key is put in argv, a generated file or output.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, mode: { type: 'string', default: 'both' },
  broadcast: { type: 'boolean', default: false },
} });
if (!values.config || !['both', 'buy-only', 'paused'].includes(values.mode)) throw new Error('Supply --config <public config> and --mode both|buy-only|paused');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/public-live-demo.json', import.meta.url), 'utf8'));
if (values.mode !== 'both') fixture.strategy.rules[0].allowMakerSellToken0 = false;
if (values.mode === 'paused') fixture.strategy.rules[0].allowMakerBuyToken0 = false;
const env = { ...process.env, TZ: 'UTC', SECRET_PROVIDER_STRATEGY: JSON.stringify(fixture.strategy),
  SECRET_PROVIDER_STRATEGY_DEFENSIVE: JSON.stringify(fixture.strategy), SECRET_MAKER_LIMITS: JSON.stringify(fixture.limits) };
if (values.broadcast) {
  env.CRE_ETH_PRIVATE_KEY = process.env.MAKER_PK ?? process.env.CRE_ETH_PRIVATE_KEY;
  if (!env.CRE_ETH_PRIVATE_KEY) throw new Error('Authorized broadcast signer must be supplied by the parent process');
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  let signer;
  try { signer = privateKeyToAccount(env.CRE_ETH_PRIVATE_KEY.startsWith('0x') ? env.CRE_ETH_PRIVATE_KEY : `0x${env.CRE_ETH_PRIVATE_KEY}`).address; }
  catch { throw new Error('Invalid broadcast signing material'); }
  if (signer.toLowerCase() !== config.maker?.toLowerCase()) throw new Error('Broadcast signer is not the planned Maker');
} else { delete env.CRE_ETH_PRIVATE_KEY; }
// The launcher never lets the CLI read an unrelated local .env.
const args = ['workflow', 'simulate', 'market-maker-auth', '--target', 'staging-settings', '--non-interactive',
  '--trigger-index', '0', '--config', resolve(values.config), '--env', '/dev/null'];
if (values.broadcast) args.push('--broadcast');
const child = spawn('cre', args, { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', () => { console.error('CRE CLI could not be started'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
