// Read-only preparation. Produces a persisted, reviewable program and executor
// requests; it never instantiates a signer or performs an asset operation.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPublicClient, http, keccak256, stringToHex, zeroAddress, zeroHash, parseAbi } from 'viem'
import { compileExecution } from '../src/execution-compile.ts'
import { concentrationBounds } from '../src/concentrated.ts'
import { parseExecutionRequest } from '../src/execution-request.ts'
import type { AquaStrategyParams, Deployment } from '../src/types.ts'

const { values } = parseArgs({ options: { out: { type: 'string' } } })
if (!values.out) throw new Error('Use --out <public plan directory>')
const dir = values.out
if (existsSync(`${dir}/plan.json`)) throw new Error('Plan exists; resume it instead of creating a new strategy')
const d: Deployment = JSON.parse(readFileSync(new URL('../deployments/11155111.json', import.meta.url), 'utf8'))
const maker = '0x32F79282124EaFc681601cDCa2883C672C72D340' as const
const pc = createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com') })
if (await pc.getChainId() !== 11155111 || d.chainId !== 11155111 || d.guard?.profile !== 'cre-simulation') throw new Error('Wrong demo deployment domain')
const active = await pc.readContract({ address: d.guard.address, abi: parseAbi(['function activeStrategyHash(address) view returns (bytes32)']), functionName: 'activeStrategyHash', args: [maker] })
if (active !== zeroHash) throw new Error('Maker already has an active strategy; inspect before planning')
const now = Number((await pc.getBlock()).timestamp)
const tokens = [d.tokens.WETH!, d.tokens.USDC!]
const strategy: AquaStrategyParams = { schema: 'aqua-swapvm-v1.0.2', chainId: 11155111, maker,
  tokens, amounts: ['2000000000000000', '5000000'],
  program: { kind: 'concentrated', feeBps: 0, deadline: now + 7200,
    salt: BigInt(keccak256(stringToHex(`cre-live-demo:${now}`)).slice(0, 18)).toString(),
    ...concentrationBounds(tokens, [18, 6], '2000', '3000') },
  guard: { address: d.guard.address, version: 2, caps: { maxAmount0PerSwap: '400000000000000',
    maxAmount1PerSwap: '1000000', maxPostBalance0: '6000000000000000', maxPostBalance1: '15000000' } },
  meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: 1 } }
const s = compileExecution(strategy)
const sessionId = `cre-live-${now}`
const envelope = { schema: 'aqua-execution-v1', sessionId }
const requests = {
  ship: { ...envelope, requestId: `${sessionId}-ship`, action: 'ship', strategy,
    policy: { tokens, baselineAmounts: strategy.amounts, maxDrawdownBps: 500, maxPriceAgeSec: 3600 } },
  swap: { ...envelope, requestId: `${sessionId}-swap`, action: 'swap', expectedStrategyHash: s.strategyHash,
    tokenIn: tokens[1], amountIn: '500000', slippageBps: 50 },
  dock: { ...envelope, requestId: `${sessionId}-dock`, action: 'dock', expectedStrategyHash: s.strategyHash, revokeAllowances: true },
}
for (const request of Object.values(requests)) parseExecutionRequest(request)
const config = JSON.parse(readFileSync(new URL('../../../workflow/market-maker-auth/config.staging.json', import.meta.url), 'utf8'))
delete config.marketSnapshot
Object.assign(config, { marketSource: 'kraken', maker, strategyHash: s.strategyHash, providerStrategies: [], publishMode: 'don-report',
  guard: d.guard.address, router: d.router, transport: { profile: 'cre-simulation', forwarder: d.guard.forwarder,
    workflowId: zeroHash, workflowOwner: zeroAddress, gasLimit: '500000' } })
mkdirSync(dir, { recursive: true })
const write = (name: string, value: unknown) => writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n')
for (const [name, request] of Object.entries(requests)) write(name, request)
write('config', config)
write('plan', { schema: 'cre-live-demo-plan-v1', createdAt: now, sessionId, deployment: d, strategy, strategyHash: s.strategyHash,
  range: { lower: '2000', upper: '3000', units: 'USDC/WETH', source: 'explicit bounded demo range; authorization uses live Kraken data' },
  tradeAmountUsdc: '0.5', stateDir: fileURLToPath(new URL(`../.state/sepolia/${maker.toLowerCase()}/`, import.meta.url)),
  steps: ['paused CRE probe', 'ship', 'CRE both-directions report', '0.5 USDC swap', 'CRE buy-only report', 'rejected USDC-in swap', 'CRE paused report', 'dock and revoke'] })
console.log(JSON.stringify({ directory: dir, sessionId, strategyHash: s.strategyHash, makerAllocation: '0.002 WETH + 5 USDC', swap: '0.5 USDC', guard: d.guard.address }))
