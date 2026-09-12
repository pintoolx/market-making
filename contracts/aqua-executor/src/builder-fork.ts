import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseAbi, TransactionReceiptNotFoundError, zeroAddress, zeroHash, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { addressSchema, canonical, digestJson, positiveAtomicSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readBuilderTokenImplementation } from './builder-token-proxy.ts'

const identityAbi = parseAbi([
  'function AQUA() view returns (address)', 'function aqua() view returns (address)', 'function router() view returns (address)',
  'function forwarder() view returns (address)', 'function guardVersion() view returns (uint8)', 'function reportSchemaVersion() view returns (uint16)',
  'function simulationMode() view returns (bool)', 'function workflowId() view returns (bytes32)', 'function workflowOwner() view returns (address)',
])
const issuerAbi = parseAbi(['function masterMinter() view returns (address)', 'function configureMinter(address minter, uint256 allowance) returns (bool)',
  'function mint(address to, uint256 amount) returns (bool)'])
const wethAbi = parseAbi(['function deposit() payable'])

/** The configured upstream is used only by read clients and Anvil's state fetcher. */
export interface BuilderForkOptions { rpcUrl: string; anvil?: string; signal?: AbortSignal; blockNumber?: bigint }
export async function startBuilderFork(profile: DeploymentProfile, options: BuilderForkOptions) {
  try { return await startFork(profile, options) } catch { throw new Error('builder-fork-unavailable') }
}

async function startFork(profile: DeploymentProfile, options: BuilderForkOptions) {
  if (profile.id !== 'sepolia-standing-v2' || profile.chainId !== sepolia.id) throw new Error('unsupported-fork-profile')
  const url = new URL(options.rpcUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported-fork-transport')
  const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const upstream = createPublicClient({ chain: sepolia, transport: http(options.rpcUrl, { retryCount: 1, timeout: 20000, fetchOptions: { signal } }) })
  const [chainId, finalized] = await Promise.all([upstream.getChainId(), upstream.getBlock({ blockTag: 'finalized' })])
  if (chainId !== profile.chainId || finalized.number === null || !finalized.hash) throw new Error('invalid-fork-context')
  if (options.blockNumber !== undefined && (options.blockNumber < 0n || options.blockNumber > finalized.number)) throw new Error('unfinalized-fork-context')
  const block = options.blockNumber === undefined ? finalized : await upstream.getBlock({ blockNumber: options.blockNumber })
  if (block.number === null || !block.hash) throw new Error('invalid-fork-context')
  const verification = JSON.parse(await readFile(new URL('../../../packages/strategy-builder/profiles/sepolia-standing-v2.verification.json', import.meta.url), 'utf8')) as {
    manifestHash: string; contracts: { address: Hex; codeHash: Hex }[]; tokenImplementation: Awaited<ReturnType<typeof readBuilderTokenImplementation>>;
  }
  if (verification.manifestHash !== digestJson(profile)) throw new Error('unverified-fork-manifest')
  // Reserve a port, then give it to the child; startup checks catch a lost bind race.
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const rpc = `http://127.0.0.1:${port}`
  const child = spawn(options.anvil ?? 'anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(profile.chainId),
    '--fork-url', options.rpcUrl, '--fork-block-number', String(block.number), '--silent'], {
    stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
  let stopped = false, unavailable = false
  child.once('error', () => { unavailable = true }); child.once('exit', () => { unavailable = true })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (!stopping) {
      stopped = true; child.kill('SIGTERM'); signal.removeEventListener('abort', onAbort)
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref()
      stopping = closed.finally(() => clearTimeout(force))
    }
    return stopping
  }
  const onAbort = () => { void stop() }
  signal.addEventListener('abort', onAbort, { once: true })
  const alive = () => { signal.throwIfAborted(); if (stopped || unavailable) throw new Error('fork-process-unavailable') }
  const pc = createPublicClient({ chain: sepolia, cacheTime: 0, pollingInterval: 100, transport: http(rpc, { retryCount: 1, timeout: 20000, fetchOptions: { signal } }) })
  const dev = async (method: string, params: unknown[]) => {
    alive()
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const value = await response.json() as { result: unknown; error?: unknown }
    if (!response.ok || value.error) throw new Error('fork-operation-failed')
    return value.result
  }
  const wallet = (account: Hex) => { alive(); return createWalletClient({ account, chain: sepolia, transport: http(rpc, { retryCount: 0, timeout: 20000 }) }) }
  // Snapshot rollback rewinds block numbers. Poll receipts directly instead of a shared monotonic block watcher.
  const waitForReceipt = async (hash: Hex) => {
    const until = Date.now() + 30000
    for (;;) {
      alive()
      try { return await pc.getTransactionReceipt({ hash }) } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error
        if (Date.now() >= until) throw new Error('fork-receipt-timeout')
        await delay(100, undefined, { signal })
      }
    }
  }
  const receipt = async (hash: Hex) => {
    const result = await waitForReceipt(hash)
    if (result.status !== 'success') throw new Error('fork-transaction-reverted')
    return result
  }
  const impersonate = async (account: Hex, native = 10n ** 20n) => {
    await dev('anvil_impersonateAccount', [account])
    await dev('anvil_setBalance', [account, `0x${native.toString(16)}`])
    return wallet(account)
  }
  try {
    for (let n = 0; ; n++) {
      alive()
      try { if (await pc.getChainId() === profile.chainId) break } catch { /* child is loading fork state */ }
      if (n >= 100) throw new Error('fork-start-timeout')
      await delay(100, undefined, { signal })
    }
    if (!String(await dev('web3_clientVersion', [])).toLowerCase().includes('anvil')) throw new Error('unexpected-fork-client')
    const forkBlock = await pc.getBlock({ blockNumber: block.number })
    if (forkBlock.hash !== block.hash) throw new Error('fork-block-mismatch')
    const contracts = await Promise.all(verification.contracts.map(async pin => {
      const code = await pc.getCode({ address: pin.address })
      if (!code || keccak256(code) !== pin.codeHash) throw new Error('fork-code-mismatch')
      return { address: pin.address, codeHash: pin.codeHash }
    }))
    const tokenImplementation = await readBuilderTokenImplementation(pc, profile, block.number)
    if (canonical(tokenImplementation) !== canonical(verification.tokenImplementation)) throw new Error('fork-token-implementation-mismatch')
    const readIdentity = (functionName: 'router' | 'aqua' | 'forwarder' | 'guardVersion' | 'reportSchemaVersion' | 'simulationMode' | 'workflowId' | 'workflowOwner') =>
      pc.readContract({ address: profile.guard, abi: identityAbi, functionName })
    const names = ['router', 'aqua', 'forwarder', 'guardVersion', 'reportSchemaVersion', 'simulationMode', 'workflowId', 'workflowOwner'] as const
    const expected = [profile.router, profile.aqua, profile.forwarder, 2, 2, true, zeroHash, zeroAddress]
    const values = await Promise.all(names.map(readIdentity))
    if (values.some((value, i) => String(value).toLowerCase() !== String(expected[i]).toLowerCase())) throw new Error('fork-guard-binding-mismatch')
    if ((await pc.readContract({ address: profile.router, abi: identityAbi, functionName: 'AQUA' })).toLowerCase() !== profile.aqua) throw new Error('fork-router-binding-mismatch')
    for (const token of profile.tokens) {
      const [symbol, decimals] = await Promise.all([
        pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol' }), pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' }),
      ])
      if (symbol !== token.symbol || decimals !== token.decimals) throw new Error('fork-token-metadata-mismatch')
    }
    // Ensure the upstream finalized context did not change during startup; no writes have occurred yet.
    if ((await upstream.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('fork-source-reorganized')
    // Frozen timestamps give quote and settlement exactly the same time; time scenarios advance explicitly.
    await dev('anvil_setBlockTimestampInterval', [0])
    const taker = privateKeyToAddress(generatePrivateKey()).toLowerCase() as Hex
    const evidence = { mode: 'fork-with-overrides' as const, chainId, manifestHash: digestJson(profile), blockNumber: String(block.number), blockHash: block.hash,
      sourceTimestamp: String(block.timestamp), contracts, tokenImplementation,
      sourceRuntimeRebuilt: false, authorization: 'synthetic-forwarder-impersonation' as const, frozenBlockTime: true,
      limitations: ['Local fork balances and report authority are synthetic.', 'No live wallet funding, DON/TEE delivery or source-to-runtime rebuild is proven.'] }
    return {
      pc, taker, evidence, dev, stop, receipt, waitForReceipt, wallet, impersonate,
      async fund(account: Hex, balances: readonly { token: Hex; amount: string }[]) {
        addressSchema.parse(account)
        if (balances.length !== profile.tokens.length || new Set(balances.map(b => b.token.toLowerCase())).size !== profile.tokens.length ||
          balances.some(b => !profile.tokens.some(t => t.address === b.token.toLowerCase()))) throw new Error('fork-funding-pair-mismatch')
        for (const balance of balances) positiveAtomicSchema.parse(balance.amount)
        const weth = profile.tokens.find(t => t.symbol === 'WETH')!, usdc = profile.tokens.find(t => t.symbol === 'USDC')!
        const needed = (address: Hex) => BigInt(balances.find(b => b.token.toLowerCase() === address)!.amount)
        const client = await impersonate(account, needed(weth.address) + 10n ** 20n)
        const wethBalance = await pc.readContract({ address: weth.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
        if (wethBalance < needed(weth.address)) await receipt(await client.writeContract({ address: weth.address, abi: wethAbi, functionName: 'deposit', value: needed(weth.address) - wethBalance }))
        const usdcBalance = await pc.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
        if (usdcBalance < needed(usdc.address)) {
          const issuer = await pc.readContract({ address: usdc.address, abi: issuerAbi, functionName: 'masterMinter' })
          const issuerClient = await impersonate(issuer)
          const amount = needed(usdc.address) - usdcBalance
          await receipt(await issuerClient.writeContract({ address: usdc.address, abi: issuerAbi, functionName: 'configureMinter', args: [account, amount] }))
          await receipt(await client.writeContract({ address: usdc.address, abi: issuerAbi, functionName: 'mint', args: [account, amount] }))
        }
        return { account, tokens: profile.tokens.map(t => ({ token: t.address, minimumBalance: String(needed(t.address)) })) }
      },
    }
  } catch {
    await stop(); throw new Error('builder-fork-unavailable')
  }
}
