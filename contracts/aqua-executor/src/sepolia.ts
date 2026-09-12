import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPublicClient, encodeDeployData, encodeFunctionData, erc20Abi, formatEther, formatUnits, http, isAddress, isHex, parseAbi, parseEther, parseUnits, zeroAddress, zeroHash, type Abi, type PublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { deploymentFile, fromEnv, NETWORKS, readJson, type Ctx } from './config.ts'
import { durableSender, type DurableRequest, type TransactionHook } from './durable-send.ts'
import { ExecutionStore, json } from './execution-store.ts'
import type { Deployment, Hex } from './types.ts'

// Issuer/deployment references and faucet instructions: docs/ETHEREUM-SEPOLIA.md.
export const SEPOLIA = {
  chainId: 11155111,
  aqua: '0x1111113ccf1426a8e30e2bff5e005d929bf6a90a',
  WETH: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  simulationForwarder: '0x15fc6ae953e024d975e77382eeec56a9101f9f88',
} as const
export const DEMO_ACCOUNTS = {
  maker: '0x24f93609de41a839f411d18f3ee242c5089caad7',
  taker: '0xdaf50f814af7a1baf555cc3a3ce3d0ffe303073c',
} as const
export const FUNDING_TARGET = {
  makerWeth: parseEther('0.005'), makerUsdc: parseUnits('10', 6),
  takerWeth: parseEther('0.001'), takerUsdc: parseUnits('5', 6), takerEth: parseEther('0.005'),
  // Operational buffer, not a quoted gas cost. Funding leaves this in the maker wallet.
  makerEthReserve: parseEther('0.012'),
}
const wethAbi = parseAbi(['function deposit() payable'])
const routerIdentityAbi = parseAbi(['function AQUA() view returns (address)'])
const activeStrategyAbi = parseAbi(['function activeStrategyHash(address maker) view returns (bytes32)'])
type ContractArtifact = { abi: Abi; bytecode: Hex; sourceHashes?: Record<string, string> }
const artifact = (name: string) => readJson(`artifacts/${name}.json`) as ContractArtifact

export const guardReleaseId = (guardArtifact: ContractArtifact = artifact('AquaGuardV2')) => {
  const digest = createHash('sha256').update(guardArtifact.bytecode).digest('hex')
  return `guard-v2-${digest.slice(0, 12)}`
}

export const versionedGuardDeploymentFile = (address: Hex) =>
  new URL(`deployments/11155111.guard-${address.toLowerCase()}.json`, new URL('../', import.meta.url))


export async function checkSepoliaAssets(pc: PublicClient) {
  if (await pc.getChainId() !== SEPOLIA.chainId) throw new Error('expected Ethereum Sepolia chainId 11155111')
  for (const [name, address] of Object.entries(SEPOLIA)) {
    if (typeof address !== 'string') continue
    const code = await pc.getCode({ address })
    if (!code || code === '0x') throw new Error(`${name} has no deployed code on Ethereum Sepolia`)
  }
  for (const [symbol, decimals] of [['WETH', 18], ['USDC', 6]] as const) {
    const address = SEPOLIA[symbol]
    const actual = await Promise.all([
      pc.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      pc.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    if (actual[0] !== symbol || actual[1] !== decimals) throw new Error(`${symbol} metadata does not match the configured asset`)
  }
}

export async function sepoliaBalances(pc: PublicClient, maker: Hex, taker: Hex) {
  if (![maker, taker].every(a => isAddress(a, { strict: false }) && a.toLowerCase() !== zeroAddress) || maker.toLowerCase() === taker.toLowerCase()) {
    throw new Error('maker and taker must be distinct nonzero addresses')
  }
  const balance = async (address: Hex) => {
    const [eth, weth, usdc] = await Promise.all([
      pc.getBalance({ address }),
      pc.readContract({ address: SEPOLIA.WETH, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      pc.readContract({ address: SEPOLIA.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    ])
    return { address, eth, weth, usdc }
  }
  return { maker: await balance(maker), taker: await balance(taker) }
}
type Balances = Awaited<ReturnType<typeof sepoliaBalances>>
type FundingStep = { step: string; request: DurableRequest }

/** Minimum-balance allocation, saved as one immutable plan before any transaction is signed. */
export function fundingPlan(b: Balances) {
  const missing = (target: bigint, actual: bigint) => target > actual ? target - actual : 0n
  const takerEth = missing(FUNDING_TARGET.takerEth, b.taker.eth)
  const takerWeth = missing(FUNDING_TARGET.takerWeth, b.taker.weth)
  const takerUsdc = missing(FUNDING_TARGET.takerUsdc, b.taker.usdc)
  const wrap = missing(FUNDING_TARGET.makerWeth + takerWeth, b.maker.weth)
  const needs: string[] = []
  if (b.maker.usdc < FUNDING_TARGET.makerUsdc + takerUsdc) needs.push(`maker needs ${formatUnits(FUNDING_TARGET.makerUsdc + takerUsdc - b.maker.usdc, 6)} more Circle testnet USDC`)
  const ethRequired = takerEth + wrap + FUNDING_TARGET.makerEthReserve
  if (b.maker.eth < ethRequired) needs.push(`maker needs ${formatEther(ethRequired - b.maker.eth)} more Sepolia ETH (includes gas reserve)`)
  const steps: FundingStep[] = []
  if (takerEth) steps.push({ step: 'fund-taker-eth', request: { to: b.taker.address, data: '0x', value: String(takerEth) } })
  if (wrap) steps.push({ step: 'wrap-weth', request: { to: SEPOLIA.WETH, data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }), value: String(wrap) } })
  for (const [step, token, amount] of [['fund-taker-weth', SEPOLIA.WETH, takerWeth], ['fund-taker-usdc', SEPOLIA.USDC, takerUsdc]] as const) {
    if (amount) steps.push({ step, request: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [b.taker.address, amount] }) } })
  }
  return { needs, steps }
}

type Options = { stateDir: string; onTransaction?: TransactionHook }
async function withStore<T>(ctx: Ctx, options: Options, requestId: string, work: (store: ExecutionStore, sender: ReturnType<typeof durableSender>) => Promise<T>) {
  if (ctx.chain.id !== SEPOLIA.chainId) throw new Error('expected Ethereum Sepolia context')
  await checkSepoliaAssets(ctx.pc)
  for (const wallet of [ctx.maker, ctx.taker]) {
    const code = await ctx.pc.getCode({ address: wallet.account.address })
    if (code && code !== '0x') throw new Error('Sepolia setup requires plain maker/taker EOAs without delegated code')
  }
  const store = new ExecutionStore(options.stateDir)
  try {
    const binding = { chainId: ctx.chain.id, maker: ctx.maker.account.address.toLowerCase(), taker: ctx.taker.account.address.toLowerCase() }
    const old = store.get('sepolia', 'binding')
    if (old && json(old) !== json(binding)) throw new Error('state directory belongs to different wallets or chain')
    store.put('sepolia', 'binding', binding)
    const rec = store.recorder(requestId, ctx.chain.id, ctx.explorer)
    const sender = durableSender(ctx, store, requestId, rec, options.onTransaction)
    await sender.audit()
    return await work(store, sender)
  } finally { try { store.export(requestId) } finally { store.close() } }
}

/** Reuses canonical Aqua and assets; never deploys or mints mock tokens. */
async function deployOne(ctx: Ctx, sender: ReturnType<typeof durableSender>, name: string, args: unknown[]) {
  const a = artifact(name)
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args })
  const previous = sender.get(name)
  if (previous && previous.request.data !== data) throw new Error(`saved ${name} deployment uses different bytecode or constructor arguments; retain its journal and inspect the receiver revision before deploying again`)
  const receipt = await sender.send(name, ctx.maker, `deploy:${name}`, zeroHash, async () => ({ data }))
  if (!receipt.contractAddress) throw new Error(`missing deployed ${name}`)
  const code = await ctx.pc.getCode({ address: receipt.contractAddress })
  if (!code || code === '0x') throw new Error(`missing deployed ${name}`)
  return receipt.contractAddress
}

async function deployReceiver(ctx: Ctx, sender: ReturnType<typeof durableSender>, router: Hex): Promise<NonNullable<Deployment['guard']>> {
  const address = await deployOne(ctx, sender, 'AquaGuardV2', [SEPOLIA.simulationForwarder, router, zeroHash, zeroAddress, true])
  await ctx.pc.readContract({ address, abi: activeStrategyAbi, functionName: 'activeStrategyHash', args: [ctx.maker.account.address] })
  return { address, version: 2, revision: 'maker-active-v1', forwarder: SEPOLIA.simulationForwarder, profile: 'cre-simulation' }
}

export async function deploySepolia(ctx: Ctx, options: Options): Promise<Deployment> {
  return withStore(ctx, options, 'sepolia-deploy-v1', async (store, sender) => {
    const router = await deployOne(ctx, sender, 'AquaSwapVMRouter', [SEPOLIA.aqua, SEPOLIA.WETH, ctx.maker.account.address, '1inch SwapVM v1.0', '1.0.2'])
    const aqua = await ctx.pc.readContract({ address: router, abi: routerIdentityAbi, functionName: 'AQUA' })
    if (aqua.toLowerCase() !== SEPOLIA.aqua) throw new Error('router AQUA does not match canonical registry')
    const guard = await deployReceiver(ctx, sender, router)
    const d: Deployment = { chainId: SEPOLIA.chainId, aqua: SEPOLIA.aqua, router, tokens: { WETH: SEPOLIA.WETH, USDC: SEPOLIA.USDC },
      guard }
    store.put('sepolia', 'deployment', d)
    return d
  })
}

/** Separate durable operation: replace the immutable receiver, retaining the router, assets and old receipts. */
export async function upgradeSepoliaGuard(ctx: Ctx, deployment: Deployment, options: Options): Promise<Deployment> {
  if (deployment.chainId !== SEPOLIA.chainId || deployment.aqua.toLowerCase() !== SEPOLIA.aqua ||
      deployment.tokens.WETH?.toLowerCase() !== SEPOLIA.WETH || deployment.tokens.USDC?.toLowerCase() !== SEPOLIA.USDC) {
    throw new Error('Guard upgrade requires canonical Ethereum Sepolia deployment')
  }
  return withStore(ctx, options, 'sepolia-guard-maker-active-v1', async (store, sender) => {
    const aqua = await ctx.pc.readContract({ address: deployment.router, abi: routerIdentityAbi, functionName: 'AQUA' })
    if (aqua.toLowerCase() !== SEPOLIA.aqua) throw new Error('router AQUA does not match canonical registry')
    const guard = await deployReceiver(ctx, sender, deployment.router)
    const d = { ...deployment, guard }
    store.put('sepolia', 'deployment', d)
    return d
  })
}

export interface GuardIdentity {
  forwarder: Hex
  workflowId: Hex
  workflowOwner: Hex
  simulation: boolean
}

export function guardIdentity(input: { forwarder?: string; workflowId?: string; workflowOwner?: string; production?: boolean }): GuardIdentity {
  const simulation = !input.production
  const forwarder = (input.forwarder ?? (simulation ? SEPOLIA.simulationForwarder : '')) as Hex
  const workflowId = (input.workflowId ?? zeroHash) as Hex
  const workflowOwner = (input.workflowOwner ?? zeroAddress) as Hex
  if (!isAddress(forwarder, { strict: false }) || forwarder.toLowerCase() === zeroAddress) throw new Error('a nonzero --forwarder is required')
  if (!isHex(workflowId) || workflowId.length !== 66 || !isAddress(workflowOwner, { strict: false })) throw new Error('invalid workflow identity')
  if (simulation && (workflowId !== zeroHash || workflowOwner.toLowerCase() !== zeroAddress)) throw new Error('simulation requires zero workflow identity')
  if (!simulation && (workflowId === zeroHash || workflowOwner.toLowerCase() === zeroAddress)) throw new Error('production requires --workflow-id and --workflow-owner')
  return { forwarder, workflowId, workflowOwner, simulation }
}

/** Deploys only the current Guard artifact while reusing the verified Aqua and router. */
export async function deployCurrentSepoliaGuard(ctx: Ctx, base: Deployment, identity: GuardIdentity, options: Options): Promise<Deployment> {
  if (base.chainId !== SEPOLIA.chainId || base.aqua.toLowerCase() !== SEPOLIA.aqua ||
      base.tokens.WETH?.toLowerCase() !== SEPOLIA.WETH || base.tokens.USDC?.toLowerCase() !== SEPOLIA.USDC) {
    throw new Error('base deployment does not match canonical Ethereum Sepolia assets')
  }
  const requestId = `${guardReleaseId()}-${identity.simulation ? 'simulation' : 'production'}`
  return withStore(ctx, options, requestId, async (_store, sender) => {
    const routerCode = await ctx.pc.getCode({ address: base.router })
    if (!routerCode || routerCode === '0x') throw new Error('base router has no code')
    const aqua = await ctx.pc.readContract({ address: base.router, abi: routerIdentityAbi, functionName: 'AQUA' })
    if (aqua.toLowerCase() !== SEPOLIA.aqua) throw new Error('base router AQUA does not match canonical registry')
    const address = await deployOne(ctx, sender, 'AquaGuardV2', [identity.forwarder, base.router, identity.workflowId, identity.workflowOwner, identity.simulation])
    await ctx.pc.readContract({ address, abi: activeStrategyAbi, functionName: 'activeStrategyHash', args: [ctx.maker.account.address] })
    return { ...base, guard: { address, version: 2, revision: 'maker-active-v1', forwarder: identity.forwarder,
      profile: identity.simulation ? 'cre-simulation' : 'cre-production' } } as Deployment
  })
}

export async function fundSepolia(ctx: Ctx, options: Options) {
  return withStore(ctx, options, 'sepolia-fund-v1', async (store, sender) => {
    let steps = store.get<FundingStep[]>('sepolia', 'funding-plan')
    if (!steps) {
      const plan = fundingPlan(await sepoliaBalances(ctx.pc, ctx.maker.account.address, ctx.taker.account.address))
      if (plan.needs.length) throw new Error(plan.needs.join('; '))
      steps = plan.steps
      store.put('sepolia', 'funding-plan', steps)
    }
    for (const { step, request } of steps) await sender.send(step, ctx.maker, step, zeroHash, async () => request)
    // Repeating this command recovers the initial allocation; it never refills assets spent by later demos.
    return sepoliaBalances(ctx.pc, ctx.maker.account.address, ctx.taker.account.address)
  })
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    execute: { type: 'boolean', default: false }, maker: { type: 'string' }, taker: { type: 'string' },
    'state-dir': { type: 'string' }, rpc: { type: 'string' }, forwarder: { type: 'string' },
    'workflow-id': { type: 'string' }, 'workflow-owner': { type: 'string' }, production: { type: 'boolean', default: false },
  } })
  const action = positionals[0] ?? 'status'
  if (positionals.length > 1 || !['status', 'deploy', 'deploy-guard', 'upgrade-guard', 'fund'].includes(action)) throw new Error('Usage: sepolia status | deploy --execute | deploy-guard --execute [identity options] | upgrade-guard --execute | fund --execute [--state-dir PATH]')
  if (action !== 'deploy-guard' && (values.production || values.forwarder || values['workflow-id'] || values['workflow-owner'])) {
    throw new Error('receiver identity options require deploy-guard; deploy and upgrade-guard create simulation receivers only')
  }

  const network = NETWORKS['ethereum-sepolia']
  const rpc = values.rpc ?? process.env[network.rpcEnv] ?? network.rpc
  if (!values.execute || action === 'status') {
    const pc = createPublicClient({ chain: sepolia, transport: http(rpc) })
    await checkSepoliaAssets(pc)
    const balances = await sepoliaBalances(pc, (values.maker ?? DEMO_ACCOUNTS.maker) as Hex, (values.taker ?? DEMO_ACCOUNTS.taker) as Hex)
    console.log(json({ mode: 'read-only', chainId: SEPOLIA.chainId, assets: SEPOLIA, balances, funding: fundingPlan(balances),
      next: action === 'status' ? 'Fund the maker, then deploy --execute and fund --execute.' : `No transaction sent. Add --execute to ${action}.` }))
    return
  }
  if (values.maker || values.taker) throw new Error('--maker/--taker are read-only status options; execution derives signers from MAKER_PK/TAKER_PK')
  process.env[network.rpcEnv] = rpc
  const ctx = fromEnv('ethereum-sepolia')
  const options = { stateDir: values['state-dir'] ?? fileURLToPath(new URL(`../.state/sepolia/${ctx.maker.account.address.toLowerCase()}`, import.meta.url)) }
  if (action === 'deploy' || action === 'upgrade-guard') {
    const d = action === 'deploy' ? await deploySepolia(ctx, options)
      : await upgradeSepoliaGuard(ctx, readJson('deployments/11155111.json') as Deployment, options)
    mkdirSync(new URL('.', deploymentFile(d.chainId)), { recursive: true })
    writeFileSync(deploymentFile(d.chainId), json(d) + '\n')
    console.log(json(d))
  } else if (action === 'deploy-guard') {
    const base = readJson('deployments/11155111.json') as Deployment
    const identity = guardIdentity({ forwarder: values.forwarder, workflowId: values['workflow-id'], workflowOwner: values['workflow-owner'], production: values.production })
    const d = await deployCurrentSepoliaGuard(ctx, base, identity, options)
    const output = versionedGuardDeploymentFile(d.guard!.address)
    writeFileSync(output, json({ ...d, guardRelease: guardReleaseId(), workflowId: identity.workflowId, workflowOwner: identity.workflowOwner }) + '\n')
    console.log(json({ deployment: d, manifest: fileURLToPath(output), next: 'Compile fresh guarded strategies against this Guard, then update product configuration after end-to-end verification.' }))
  } else console.log(json(await fundSepolia(ctx, options)))
  console.log(`records: ${join(options.stateDir, 'records')}`)
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  // Do not print viem request details containing serialized signed transactions.
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'Sepolia operation failed'); process.exitCode = 1
})
