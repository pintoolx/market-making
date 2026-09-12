// Local, read-only preparation tool. This file is not imported by the WASM entry point.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, encodeDeployData, http, keccak256, stringToHex, zeroAddress, zeroHash, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import artifact from '../../../contracts/aqua-executor/artifacts/AquaGuardV2.json'
type Deployment = { chainId: number; router: Hex; tokens: Record<string, Hex> }
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
function checkDeployment(deployment: Deployment) {
  if (deployment.chainId !== 11155111 || !deployment.router || deployment.router.toLowerCase() === zeroAddress ||
      deployment.tokens.WETH?.toLowerCase() !== WETH || deployment.tokens.USDC?.toLowerCase() !== USDC) {
    throw new Error('Requires confirmed Ethereum Sepolia deployment with WETH / Circle USDC')
  }
}
import { CHAIN_ID, SIMULATION_FORWARDER, receiverAbi } from '../config'
import { encodePublicReport, requireCurrent } from '../report'
import { configSchema } from '../config'

export const simulationTransport = { profile: 'cre-simulation' as const, forwarder: SIMULATION_FORWARDER,
  workflowId: zeroHash, workflowOwner: zeroAddress, gasLimit: '500000' }

export function simulationDeploymentPlan(deployment: Deployment) {
  checkDeployment(deployment)
  const args = [SIMULATION_FORWARDER, deployment.router, zeroHash, zeroAddress, true] as const
  return { status: 'unsigned simulation-only Guard creation; not broadcast', chainId: CHAIN_ID, value: '0',
    constructorArgs: args, data: encodeDeployData({ abi: receiverAbi, bytecode: artifact.bytecode as Hex, args }) }
}

export function smokeConfig(deployment: Deployment, guard: string, maker: string, nonce: string, timestamp: number) {
  checkDeployment(deployment)
  // Deliberately unshipped probe hash: this checks delivery, not activation or trading.
  const strategyHash = keccak256(stringToHex(`pintool:cre-delivery-smoke:v1:${guard.toLowerCase()}:${maker.toLowerCase()}`))
  const { report } = encodePublicReport({ schemaVersion: '1', chainId: CHAIN_ID, guard, maker, router: deployment.router,
    strategyHash, token0: deployment.tokens.WETH, token1: deployment.tokens.USDC, nonce,
    validAfter: String(timestamp), validUntil: String(timestamp + 300), allowedDirections: '0',
    maxAmount0PerSwap: '0', maxAmount1PerSwap: '0', maxPostBalance0: '0', maxPostBalance1: '0' })
  requireCurrent(report, timestamp)
  return configSchema.parse({ schedule: '0 */5 * * * *', transport: simulationTransport, publicReport: report })
}

async function prepare() {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { guard: { type: 'string' }, maker: { type: 'string' }, nonce: { type: 'string' }, out: { type: 'string' }, rpc: { type: 'string' }, deployment: { type: 'string' } } })
  if (positionals.length !== 1 || !['deployment', 'config'].includes(positionals[0]!)) {
    throw new Error('Usage: bun run setup:guard deployment | config --guard ADDRESS --maker ADDRESS --nonce INTEGER [--out PATH] [--rpc URL] [--deployment PATH]')
  }
  const deployment = JSON.parse(readFileSync(values.deployment ?? new URL('../../../contracts/aqua-executor/deployments/11155111.json', import.meta.url), 'utf8')) as Deployment
  checkDeployment(deployment)
  mkdirSync('.cache', { recursive: true })
  if (positionals[0] === 'deployment') {
    const path = values.out ?? '.cache/cre-simulation-guard-deployment.json'
    writeFileSync(path, JSON.stringify(simulationDeploymentPlan(deployment), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(`Unsigned creation saved to ${path}; use an Ethereum Sepolia wallet to deploy when ready.`)
    return
  }
  if (!values.guard || !values.maker || !values.nonce) throw new Error('config requires --guard, --maker and an explicit --nonce')
  const client = createPublicClient({ chain: sepolia, transport: http(values.rpc ?? 'https://ethereum-sepolia-rpc.publicnode.com') })
  let config = smokeConfig(deployment, values.guard, values.maker, values.nonce, Math.floor(Date.now() / 1000))
  const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: config.publicReport.guard, abi: receiverAbi, functionName, args })
  let state: unknown[]
  try {
    state = await Promise.all([client.getChainId(), client.getBlock(), read('forwarder'), read('router'),
      read('simulationMode'), read('workflowId'), read('workflowOwner'), read('getReport', [config.publicReport.maker, config.publicReport.strategyHash])])
  } catch { throw new Error('Could not read Ethereum Sepolia Guard state; check the RPC and deployed Guard address') }
  const [chainId, block, ...stored] = state
  const expected = [SIMULATION_FORWARDER, deployment.router.toLowerCase(), true, zeroHash, zeroAddress]
  if (chainId !== Number(CHAIN_ID) || expected.some((v, i) => v !== (typeof stored[i] === 'string' ? stored[i].toLowerCase() : stored[i]))) {
    throw new Error('Guard must use the pinned router and official CRE simulation forwarder with zero workflow identity')
  }
  const [oldReport] = stored[5] as [{ nonce: bigint }, Hex]
  if (oldReport.nonce >= BigInt(values.nonce)) throw new Error('Nonce is already used; inspect the prior delivery and retain its original config for retry')
  config = smokeConfig(deployment, values.guard, values.maker, values.nonce, Number((block as { timestamp: bigint }).timestamp))
  requireCurrent(config.publicReport, Math.floor(Date.now() / 1000))
  const path = values.out ?? 'config.generated.json'
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ config: path, kind: 'paused-unshipped-smoke', ...encodePublicReport(config.publicReport) }))
}

if (import.meta.main) prepare().catch(error => { console.error(error instanceof Error ? error.message : 'Guard preparation failed'); process.exitCode = 1 })
