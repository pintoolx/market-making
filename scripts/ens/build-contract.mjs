import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const solc = process.env.SOLC ?? 'solc';
if (!execFileSync(solc, ['--version'], { encoding: 'utf8' }).includes('0.8.30+commit.73712a01')) throw new Error('ENS registrar requires solc 0.8.30');
const source = readFileSync(new URL('../../contracts/ens/PinToolNamespaceRegistrar.sol', import.meta.url), 'utf8');
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } };
const output = JSON.parse(execFileSync(solc, ['--standard-json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  input: JSON.stringify({ language: 'Solidity', sources: { 'PinToolNamespaceRegistrar.sol': { content: source } }, settings }) }));
for (const error of output.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
const c = output.contracts['PinToolNamespaceRegistrar.sol'].PinToolNamespaceRegistrar;
const artifact = JSON.stringify({ contractName: 'PinToolNamespaceRegistrar', abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`,
  deployedBytecode: `0x${c.evm.deployedBytecode.object}`, immutableReferences: c.evm.deployedBytecode.immutableReferences,
  compiler: '0.8.30+commit.73712a01', sourceSha256: createHash('sha256').update(source).digest('hex') }, null, 2) + '\n';
const dest = new URL('../../shared/ens/PinToolNamespaceRegistrar.json', import.meta.url);
if (process.argv.includes('--check')) { if (readFileSync(dest, 'utf8') !== artifact) throw new Error('ENS registrar artifact differs; rebuild.'); }
else writeFileSync(dest, artifact);
console.log(`ENS registrar: ${c.evm.bytecode.object.length / 2} bytes; ${process.argv.includes('--check') ? 'verified' : 'built'}`);
