import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { encodeFunctionData, parseEther, parseUnits, type Abi } from 'viem'
import { mockTokenAbi } from './abi.ts'
import { deploymentFile, fromEnv, RECORDS_DIR, type Ctx } from './config.ts'
import { send, waitMined } from './executor.ts'
import { recorder, runStamp, type Recorder } from './records.ts'
import type { Deployment, Hex } from './types.ts'

const BASE_SEPOLIA_WETH = '0x4200000000000000000000000000000000000006'

const artifact = (name: string): { abi: Abi; bytecode: Hex } =>
  JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), 'utf8'))

/**
 * Base Sepolia has no official Aqua / SwapVM deployment, so deploy the official unmodified sources
 * (AquaRouter @ aqua 9c5c42e, AquaSwapVMRouter @ swap-vm v1.0.2, built by scripts/build-artifacts.sh)
 * plus two mintable mock tokens, and fund maker + taker.
 */
export async function deploy(ctx: Ctx, rec: Recorder): Promise<Deployment> {
  if (![31337, 84532].includes(ctx.chain.id) || await ctx.pc.getChainId() !== ctx.chain.id) {
    throw new Error('mock deployment requires local or Base Sepolia; use sepolia deploy --execute for Ethereum Sepolia assets')
  }
  const owner = ctx.maker.account.address
  const taker = ctx.taker.account.address
  const dep = async (name: string, label: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name)
    const r = await waitMined(ctx, await ctx.maker.deployContract({ abi, bytecode, args }))
    rec.execution(`deploy:${label}`, r)
    if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${label} failed: ${r.transactionHash}`)
    return r.contractAddress
  }

  const aqua = await dep('AquaRouter', 'Aqua', [owner])
  const mWETH = await dep('MockERC20', 'mWETH', ['Mock WETH', 'mWETH', 18])
  const mUSDC = await dep('MockERC20', 'mUSDC', ['Mock USDC', 'mUSDC', 6])
  // The router only uses WETH for unwrapping, which Aqua orders forbid; point it at the chain's real WETH when there is one.
  const weth = ctx.chain.id === 84532 ? BASE_SEPOLIA_WETH : mWETH
  const router = await dep('AquaSwapVMRouter', 'AquaSwapVMRouter', [aqua, weth, owner, '1inch SwapVM v1.0', '1.0.2'])

  const mints: [Hex, Hex, bigint][] = [
    [mWETH, owner, parseUnits('100', 18)],
    [mUSDC, owner, parseUnits('250000', 6)],
    [mWETH, taker, parseUnits('10', 18)],
    [mUSDC, taker, parseUnits('10000', 6)],
  ]
  for (const [token, to, amount] of mints) {
    await send(ctx, ctx.maker, { to: token, data: encodeFunctionData({ abi: mockTokenAbi, functionName: 'mint', args: [to, amount] }) }, 'mint', rec)
  }
  // taker needs gas for approve + swap: ~0.0000025 ETH per rebalance run at Base Sepolia's ~0.006 gwei
  if ((await ctx.pc.getBalance({ address: taker })) < parseEther('0.0001')) {
    rec.execution('fund-taker', await waitMined(ctx, await ctx.maker.sendTransaction({ to: taker, value: parseEther('0.0005') })))
  }
  return { chainId: ctx.chain.id, aqua, router, tokens: { mWETH, mUSDC } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { network: { type: 'string', default: 'local' } } })
  const ctx = fromEnv(values.network)
  const rec = recorder({ dir: RECORDS_DIR, runId: `deploy-${runStamp()}`, chainId: ctx.chain.id, explorer: ctx.explorer })
  const d = await deploy(ctx, rec)
  mkdirSync(new URL('.', deploymentFile(d.chainId)), { recursive: true })
  writeFileSync(deploymentFile(d.chainId), JSON.stringify(d, null, 2) + '\n')
  console.log(JSON.stringify(d, null, 2))
  console.log(`records: ${rec.file}`)
}
