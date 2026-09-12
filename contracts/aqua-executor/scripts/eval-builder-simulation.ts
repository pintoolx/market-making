import { mkdir, writeFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { sepoliaStandingProfile as profile } from '@pintool/strategy-builder'
import { compileBuilderStrategy } from '../src/builder-compile.ts'
import { simulateBuilderLifecycle } from '../src/builder-simulation.ts'
import { builderSimulationFixture } from './builder-simulation-fixture.ts'

// Fresh, unfunded public identities. All transactions are confined to each child Anvil.
const kind = process.argv[2] ?? 'xyc'
try {
  if (!['xyc', 'concentrated', 'pegged'].includes(kind)) throw new Error('unsupported-fixture-curve')
  const maker = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const draft = builderSimulationFixture(kind as 'xyc' | 'concentrated' | 'pegged', maker)
  const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))
  const result = await simulateBuilderLifecycle(draft, compiled, profile, { rpcUrl: process.env.BUILDER_FORK_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    anvil: process.env.ANVIL, blockNumber: process.env.BUILDER_FORK_BLOCK ? BigInt(process.env.BUILDER_FORK_BLOCK) : undefined })
  const directory = new URL('../../../.cache/builder/', import.meta.url)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL(`lifecycle-${kind}.json`, directory), JSON.stringify({ draft, compiled, result }, null, 2) + '\n')
  console.log(JSON.stringify({ kind, passed: result.passed, coverageComplete: result.coverageComplete, mode: result.mode, blockNumber: result.blockNumber,
    cases: result.cases.map(({ name, passed, error, details }) => ({ name, passed, ...(error ? { error, details } : {}) })), swaps: result.swaps.length }))
  if (!result.passed) process.exitCode = 1
} catch { console.error('Builder lifecycle evaluation failed without exposing provider details.'); process.exitCode = 1 }
