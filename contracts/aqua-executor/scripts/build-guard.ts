import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const solc = process.env.SOLC ?? 'solc'
const version = execFileSync(solc, ['--version'], { encoding: 'utf8' })
if (!version.includes('0.8.30+commit.73712a01')) throw new Error('Guard build requires solc 0.8.30+commit.73712a01')
const files = ['contracts/AquaGuard.sol', 'contracts/vendor/SwapVMInterfaces.sol', 'contracts/test/GuardTestForwarder.sol']
const sources = Object.fromEntries(files.map(path => [path, { content: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }]))
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
const result = JSON.parse(execFileSync(solc, ['--standard-json'], {
  input: JSON.stringify({ language: 'Solidity', sources, settings }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}))
for (const e of result.errors ?? []) {
  if (e.severity === 'error') throw new Error(e.formattedMessage)
  console.error(e.formattedMessage)
}
for (const [file, name] of [[files[0]!, 'AquaGuard'], [files[2]!, 'GuardTestForwarder']]) {
  const compiled = result.contracts[file!][name!]
  const artifact = { contractName: name, abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`,
    compiler: { solc: '0.8.30+commit.73712a01', optimizer: settings.optimizer, viaIR: true, evmVersion: 'prague' },
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([path, s]) => [path, createHash('sha256').update(s.content).digest('hex')])) }
  const json = JSON.stringify(artifact, null, 2) + '\n'
  const dest = new URL(`../artifacts/${name}.json`, import.meta.url)
  if (process.argv.includes('--check')) {
    if (readFileSync(dest, 'utf8') !== json) throw new Error(`${name}: committed artifact differs; rebuild it`)
  } else writeFileSync(dest, json)
  console.log(`${name}: ${compiled.evm.bytecode.object.length / 2} bytes; ${process.argv.includes('--check') ? 'matches' : 'written'}`)
}
