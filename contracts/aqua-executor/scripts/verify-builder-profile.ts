import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { digestJson, sepoliaStandingProfile } from '@pintool/strategy-builder'
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, zeroAddress, zeroHash, type Abi } from 'viem'
import { sepolia } from 'viem/chains'
import { readBuilderTokenImplementation } from '../src/builder-token-proxy.ts'

const root = new URL('../../../', import.meta.url)
const file = (name: string) => new URL(name, root)
const load = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'))
const profile = sepoliaStandingProfile
const rpc = process.argv[2] ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const pc = createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 1, timeout: 20_000 }) })

try {
  const [chainId, block] = await Promise.all([pc.getChainId(), pc.getBlock({ blockTag: 'finalized' })])
  if (chainId !== profile.chainId || block.number === null || !block.hash) throw new Error('wrong or unfinalized chain context')
  const bundle = load('contracts/aqua-executor/deployments/11155111.json')
  if (bundle.guard.address !== profile.guard || bundle.router !== profile.router || bundle.aqua !== profile.aqua || bundle.guard.forwarder !== profile.forwarder) throw new Error('Builder and executor deployment bundles differ')
  const artifact = load('contracts/aqua-executor/artifacts/AquaGuardV2.json') as { abi: Abi }
  const names = ['router', 'aqua', 'forwarder', 'guardVersion', 'reportSchemaVersion', 'simulationMode', 'workflowId', 'workflowOwner'] as const
  const values = await Promise.all(names.map(functionName => pc.readContract({ address: profile.guard, abi: artifact.abi, functionName, blockNumber: block.number })))
  const bindings = Object.fromEntries(names.map((name, i) => [name, typeof values[i] === 'bigint' ? String(values[i]) : values[i]]))
  for (const [name, expected] of Object.entries({ router: profile.router, aqua: profile.aqua, forwarder: profile.forwarder,
    guardVersion: 2, reportSchemaVersion: 2, simulationMode: true, workflowId: zeroHash, workflowOwner: zeroAddress })) {
    if (String(bindings[name]).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`binding mismatch: ${name}`)
  }
  const routerAqua = await pc.readContract({ address: profile.router, abi: parseAbi(['function AQUA() view returns (address)']), functionName: 'AQUA', blockNumber: block.number })
  if (routerAqua.toLowerCase() !== profile.aqua) throw new Error('router AQUA mismatch')
  const addresses = { aqua: profile.aqua, router: profile.router, guard: profile.guard, forwarder: profile.forwarder,
    ...Object.fromEntries(profile.tokens.map(t => [t.symbol, t.address])) }
  const contracts = await Promise.all(Object.entries(addresses).map(async ([name, address]) => {
    const code = await pc.getBytecode({ address, blockNumber: block.number })
    if (!code || code === '0x') throw new Error(`empty code: ${name}`)
    return { name, address, runtimeBytes: (code.length - 2) / 2, codeHash: keccak256(code) }
  }))
  const tokenImplementation = await readBuilderTokenImplementation(pc, profile, block.number)
  for (const token of profile.tokens) {
    const decimals = await pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals', blockNumber: block.number })
    const symbol = await pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol', blockNumber: block.number })
    if (decimals !== token.decimals || symbol !== token.symbol) throw new Error('token metadata mismatch')
  }
  const sameBlock = await pc.getBlock({ blockNumber: block.number })
  if (sameBlock.hash !== block.hash) throw new Error('verification block changed')
  const paths = ['contracts/aqua-executor/artifacts/AquaGuardV2.json', 'contracts/aqua-executor/artifacts/AquaSwapVMRouter.json',
    'contracts/aqua-executor/contracts/AquaGuardV2.sol', 'contracts/aqua-executor/src/guard.ts',
    'contracts/aqua-executor/src/guard-compile.ts', 'contracts/aqua-executor/src/builder-compile.ts',
    'contracts/aqua-executor/src/builder-token-proxy.ts', 'packages/strategy-builder/src/capabilities.ts']
  const evidence = { schemaVersion: 1, profileId: profile.id, manifestHash: digestJson(profile), mode: 'live-read',
    rpcHost: new URL(rpc).hostname, checkedAt: new Date().toISOString(), chainId,
    blockNumber: String(block.number), blockHash: block.hash, blockTimestamp: String(block.timestamp),
    contracts, tokenImplementation, bindings: { ...bindings, routerAqua }, opcodeTableHash: profile.opcodeTableHash,
    sourceHashes: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(file(path))).digest('hex')])),
    limits: ['Code presence and immutable bindings verified at one finalized block.', 'This read does not independently rebuild deployed runtime bytecode from source.',
      'No swap transaction or production DON/TEE attestation was performed.', 'Recipe execution evidence remains separate from deployment reads.'],
  }
  mkdirSync(file('packages/strategy-builder/profiles/'), { recursive: true })
  writeFileSync(file('packages/strategy-builder/profiles/sepolia-standing-v2.verification.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ profileId: profile.id, blockNumber: evidence.blockNumber, contractsVerified: contracts.length, mode: evidence.mode }))
} catch (error) {
  // RPC exceptions may contain a credential-bearing URL. Do not print their bodies or stack.
  console.error('Builder profile verification failed; inspect network availability and expected public bindings.')
  process.exitCode = 1
}
