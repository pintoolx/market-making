import { readFile } from 'node:fs/promises'
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, zeroAddress, zeroHash, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { addressSchema, canonical, digestJson, hashSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { aquaAbi } from './abi.ts'
import { readBuilderTokenImplementation } from './builder-token-proxy.ts'

const identityAbi = parseAbi([
  'function AQUA() view returns (address)', 'function aqua() view returns (address)', 'function router() view returns (address)',
  'function forwarder() view returns (address)', 'function guardVersion() view returns (uint8)', 'function reportSchemaVersion() view returns (uint16)',
  'function simulationMode() view returns (bool)', 'function workflowId() view returns (bytes32)', 'function workflowOwner() view returns (address)',
  'function activeStrategyHash(address maker) view returns (bytes32)',
])
export const inventoryEngine = 'builder-inventory-v1'
export interface InventoryReadOptions { rpcUrl: string; signal?: AbortSignal; evidenceMode?: 'live-read' | 'fork-with-overrides' }

/** Read-only adapter with operator-owned RPC configuration. All amounts and code
 * checks use one numbered block; a final hash check rejects a reorganized read.
 * Caller supplies only hashes verified against its owned artifact repository. */
export async function readBuilderInventory(profile: DeploymentProfile, makerInput: string, hashes: readonly string[], options: InventoryReadOptions) {
  try { return await readInventory(profile, makerInput, hashes, options) }
  catch (error) {
    const codes = ['inventory-strategy-budget','unsupported-inventory-profile','unsupported-inventory-transport', 'inventory-manifest-unverified',
      'inventory-block-unavailable','inventory-code-mismatch','inventory-token-implementation-mismatch','inventory-guard-binding-mismatch',
      'inventory-router-binding-mismatch','inventory-token-metadata-mismatch','inventory-block-reorganized']
    throw new Error(error instanceof Error && codes.includes(error.message) ? error.message : 'inventory-read-unavailable')
  }
}
async function readInventory(profile: DeploymentProfile, makerInput: string, hashes: readonly string[], options: InventoryReadOptions) {
  const maker = addressSchema.parse(makerInput), strategyHashes = [...new Set(hashes.map(h => hashSchema.parse(h)))]
  if (strategyHashes.length > 40 || strategyHashes.includes(zeroHash)) throw new Error('inventory-strategy-budget')
  if (profile.id !== 'sepolia-standing-v2' || profile.chainId !== sepolia.id) throw new Error('unsupported-inventory-profile')
  const url = new URL(options.rpcUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported-inventory-transport')
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const pc = createPublicClient({ chain: sepolia, cacheTime: 0, transport: http(options.rpcUrl, { retryCount: 1, timeout: 10000, fetchOptions: { signal } }) })
  try {
    const verification = JSON.parse(await readFile(new URL('../../../packages/strategy-builder/profiles/sepolia-standing-v2.verification.json', import.meta.url), 'utf8')) as {
      manifestHash: string; contracts: { address: Hex; codeHash: Hex }[]; tokenImplementation: Awaited<ReturnType<typeof readBuilderTokenImplementation>>;
    }
    if (verification.manifestHash !== digestJson(profile)) throw new Error('inventory-manifest-unverified')
    const [chainId, block] = await Promise.all([pc.getChainId(), pc.getBlock({ blockTag: 'latest' })])
    const now = Math.floor(Date.now() / 1000)
    if (chainId !== profile.chainId || block.number === null || !block.hash || Number(block.timestamp) > now + 30 || Number(block.timestamp) < now - 120) throw new Error('inventory-block-unavailable')
    const blockNumber = block.number
    const contracts = await Promise.all(verification.contracts.map(async pin => {
      const code = await pc.getCode({ address: pin.address, blockNumber })
      if (!code || keccak256(code) !== pin.codeHash) throw new Error('inventory-code-mismatch')
      return pin
    }))
    const tokenImplementation = await readBuilderTokenImplementation(pc, profile, blockNumber)
    if (canonical(tokenImplementation) !== canonical(verification.tokenImplementation)) throw new Error('inventory-token-implementation-mismatch')
    const names = ['router', 'aqua', 'forwarder', 'guardVersion', 'reportSchemaVersion', 'simulationMode', 'workflowId', 'workflowOwner'] as const
    const values = await Promise.all(names.map(functionName => pc.readContract({ address: profile.guard, abi: identityAbi, functionName, blockNumber })))
    const expected = [profile.router, profile.aqua, profile.forwarder, 2, 2, true, zeroHash, zeroAddress]
    if (values.some((v, i) => String(v).toLowerCase() !== String(expected[i]).toLowerCase())) throw new Error('inventory-guard-binding-mismatch')
    if ((await pc.readContract({ address: profile.router, abi: identityAbi, functionName: 'AQUA', blockNumber })).toLowerCase() !== profile.aqua) throw new Error('inventory-router-binding-mismatch')
    const [nativeBalance, activeStrategyHash, tokens] = await Promise.all([
      pc.getBalance({ address: maker, blockNumber }),
      pc.readContract({ address: profile.guard, abi: identityAbi, functionName: 'activeStrategyHash', args: [maker], blockNumber }),
      Promise.all(profile.tokens.map(async token => {
        const [symbol, decimals, balance, allowance] = await Promise.all([
          pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol', blockNumber }),
          pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
          pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [maker], blockNumber }),
          pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [maker, profile.aqua], blockNumber }),
        ])
        if (symbol !== token.symbol || decimals !== token.decimals) throw new Error('inventory-token-metadata-mismatch')
        return { ...token, walletBalanceAtomic: String(balance), allowanceToAquaAtomic: String(allowance) }
      })),
    ])
    const strategies = []
    // Bound parallel RPC pressure to one strategy's token pair at a time.
    const selected = activeStrategyHash.toLowerCase() as Hex
    const readHashes = selected === zeroHash || strategyHashes.includes(selected) ? strategyHashes : [selected, ...strategyHashes]
    for (const strategyHash of readHashes) {
      const balances = await Promise.all(tokens.map(async token => {
        const [balance, tokensCount] = await pc.readContract({ address: profile.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [maker, profile.router, strategyHash, token.address], blockNumber })
        const capacity = [balance, BigInt(token.walletBalanceAtomic), BigInt(token.allowanceToAquaAtomic)].reduce((a, b) => a < b ? a : b)
        return { token: token.address, virtualBalanceAtomic: String(balance), tokensCount,
          inventoryAndAllowanceCapacityAtomic: tokensCount === 2 ? String(capacity) : '0' }
      }))
      const state = balances.every(b => b.tokensCount === 0) ? 'unregistered-for-pair' as const
        : balances.every(b => b.tokensCount === 255) ? 'docked' as const : balances.every(b => b.tokensCount === 2) ? 'shipped' as const : 'inconsistent-pair' as const
      strategies.push({ strategyHash, state, source: strategyHashes.includes(strategyHash) ? 'owned-artifact' as const : 'guard-selection' as const,
        selectedByGuard: strategyHash === selected, balances })
    }
    if ((await pc.getBlock({ blockNumber })).hash !== block.hash) throw new Error('inventory-block-reorganized')
    signal.throwIfAborted()
    return { schemaVersion: 1 as const, engineVersion: inventoryEngine, mode: options.evidenceMode ?? 'live-read' as const, chainId, manifestHash: digestJson(profile), maker,
      blockNumber: String(blockNumber), blockHash: block.hash, blockTimestamp: String(block.timestamp), observedAt: new Date().toISOString(), finality: 'latest-unfinalized' as const,
      contracts, tokenImplementation, sourceRuntimeRebuilt: false as const,
      native: { symbol: 'ETH', decimals: 18, walletBalanceAtomic: String(nativeBalance) }, spender: profile.aqua,
      tokens, activeStrategyHash: activeStrategyHash.toLowerCase() as Hex, strategies,
      commitmentsComplete: false as const, registrationReady: false as const,
      limitations: ['ETH is gas currency and is not WETH; no wrapping or approval is performed.',
        'Ship records virtual inventory without depositing tokens. Wallet and virtual balances must not be added.',
        'These known strategy hashes are not an exhaustive scan of all Aqua apps, wallets or other commitments.',
        'Per-strategy inventory/allowance capacity shares the same wallet funds; capacities cannot be summed or treated as uncommitted funds.',
        'Guard selection alone does not prove an active report. Curve, report caps, deadlines, transfer behavior and gas can further restrict a trade.',
        'A fixed recent block is still unfinalized; re-read wallet and chain state before signing.'],
    }
  } catch (error) {
    // Provider exceptions can carry credential-bearing URLs and request metadata.
    const code = error instanceof Error && /^inventory-[a-z-]+$/.test(error.message) ? error.message : 'inventory-read-unavailable'
    throw new Error(code)
  }
}
export type BuilderInventory = Awaited<ReturnType<typeof readBuilderInventory>>
