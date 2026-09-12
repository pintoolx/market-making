import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { baseSepolia, foundry, sepolia } from 'viem/chains'
import type { Deployment, Hex } from './types.ts'

export type Wallet = WalletClient<Transport, Chain, PrivateKeyAccount>
export interface Ctx {
  chain: Chain
  pc: PublicClient<Transport, Chain>
  maker: Wallet
  taker: Wallet
  explorer: string | null
}

export const NETWORKS = {
  local: { chain: foundry, rpcEnv: 'LOCAL_RPC_URL', rpc: 'http://127.0.0.1:8545', explorer: null },
  'ethereum-sepolia': { chain: sepolia, rpcEnv: 'ETHEREUM_SEPOLIA_RPC_URL', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
  'base-sepolia': { chain: baseSepolia, rpcEnv: 'BASE_SEPOLIA_RPC_URL', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
} as const

// anvil's well-known dev keys #0 / #1: public, local chain only
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
] as const

export function connect(chain: Chain, rpc: string, makerPk: Hex, takerPk: Hex, explorer: string | null = null): Ctx {
  const transport = http(rpc, { retryCount: 6 }) // ~9.5s backoff on 429/5xx; also covers receipt polling
  const pollingInterval = chain.id === foundry.id ? 100 : 1_000 // viem's 4s default makes 13 sequential txs crawl
  const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport })
  return { chain, pc: createPublicClient({ chain, transport, pollingInterval }), maker: wallet(makerPk), taker: wallet(takerPk), explorer }
}

export function fromEnv(network: string): Ctx {
  if (!(network in NETWORKS)) throw new Error(`unknown network "${network}" (use: ${Object.keys(NETWORKS).join(', ')})`)
  const n = NETWORKS[network as keyof typeof NETWORKS]
  const rpc = process.env[n.rpcEnv] ?? n.rpc
  if (network === 'local') return connect(n.chain, rpc, ANVIL_KEYS[0], ANVIL_KEYS[1])
  const { MAKER_PK, TAKER_PK } = process.env
  if (!MAKER_PK || !TAKER_PK) throw new Error('set MAKER_PK and TAKER_PK in .env (see .env.example)')
  return connect(n.chain, rpc, MAKER_PK as Hex, TAKER_PK as Hex, n.explorer)
}

const root = new URL('../', import.meta.url)
export const RECORDS_DIR = fileURLToPath(new URL('records/', root))
export const deploymentFile = (chainId: number) => new URL(`deployments/${chainId}.json`, root)
export const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

export function loadDeployment(chainId: number): Deployment {
  try {
    return JSON.parse(readFileSync(deploymentFile(chainId), 'utf8'))
  } catch {
    throw new Error(`no deployments/${chainId}.json; run: npm run deploy -- --network <network>`)
  }
}
