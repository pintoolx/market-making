import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createPublicClient, decodeAbiParameters, decodeFunctionData, encodeFunctionData, erc20Abi, http, isAddress, keccak256, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { aquaAbi, routerAbi } from '../src/abi.ts'
import { takerTraits } from '../src/compile.ts'
import { loadDeployment } from '../src/config.ts'

// Public chain reads and unsigned calldata only. No wallet client or signing keys.
const { values } = parseArgs({ options: {
  'ship-transaction': { type: 'string' }, 'strategy-hash': { type: 'string' },
  maker: { type: 'string' }, taker: { type: 'string' }, 'token-in': { type: 'string' },
  'amount-in': { type: 'string' }, 'slippage-bps': { type: 'string', default: '50' },
  rpc: { type: 'string', default: 'https://ethereum-sepolia-rpc.publicnode.com' }, output: { type: 'string' },
} })
const hex32 = (s: unknown): s is Hex => typeof s === 'string' && /^0x[0-9a-f]{64}$/i.test(s)
if (!hex32(values['ship-transaction']) || !hex32(values['strategy-hash']) || !values.maker || !isAddress(values.maker)
  || !values.taker || !isAddress(values.taker) || !values['token-in'] || !isAddress(values['token-in'])
  || !/^[1-9][0-9]{0,76}$/.test(values['amount-in'] ?? '') || !values.output) throw new Error('Provide ship transaction, expected strategy hash, Maker, Taker, token-in, atomic amount-in and a new output file.')
const slippage = Number(values['slippage-bps'])
if (!Number.isInteger(slippage) || slippage < 1 || slippage > 100) throw new Error('Slippage must be 1–100 bps.')
const d = loadDeployment(sepolia.id)
const client = createPublicClient({ chain: sepolia, transport: http(values.rpc, { timeout: 15000, retryCount: 1 }) })
if (await client.getChainId() !== sepolia.id) throw new Error('RPC is not Ethereum Sepolia.')
const [tx, receipt] = await Promise.all([
  client.getTransaction({ hash: values['ship-transaction'] }), client.getTransactionReceipt({ hash: values['ship-transaction'] }),
])
if (receipt.status !== 'success' || tx.from.toLowerCase() !== values.maker.toLowerCase() || tx.to?.toLowerCase() !== d.aqua.toLowerCase()
  || tx.value !== 0n || tx.blockHash !== receipt.blockHash) throw new Error('Ship receipt does not match the selected Maker and Aqua deployment.')
const call = decodeFunctionData({ abi: aquaAbi, data: tx.input })
if (call.functionName !== 'ship') throw new Error('The source transaction must be Aqua.ship.')
const [app, strategy, tokens] = call.args
if (app.toLowerCase() !== d.router.toLowerCase() || keccak256(strategy).toLowerCase() !== values['strategy-hash'].toLowerCase()
  || tokens.length !== 2 || tokens[0]!.toLowerCase() !== d.tokens.WETH!.toLowerCase() || tokens[1]!.toLowerCase() !== d.tokens.USDC!.toLowerCase()) throw new Error('The shipped strategy or pair differs from the reviewed version.')
const [order] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], strategy)
if (order.maker.toLowerCase() !== values.maker.toLowerCase()) throw new Error('Order Maker mismatch.')
const tokenIn = tokens.find(t => t.toLowerCase() === values['token-in']!.toLowerCase())
const tokenOut = tokens.find(t => t.toLowerCase() !== values['token-in']!.toLowerCase())
if (!tokenIn || !tokenOut) throw new Error('Input token is not in this strategy.')
const amountIn = BigInt(values['amount-in']!), taker = values.taker as Hex
const block = await client.getBlock()
if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 90) throw new Error('RPC block is stale.')
const quoted = await client.readContract({ address: d.router, abi: routerAbi, functionName: 'quote',
  account: taker, args: [order, tokenIn, tokenOut, amountIn, takerTraits(0n)], blockNumber: block.number })
if (quoted[0] !== amountIn || quoted[1] <= 0n || quoted[2].toLowerCase() !== values['strategy-hash'].toLowerCase()) throw new Error('Quote did not match the requested strategy and exact input.')
const minAmountOut = quoted[1] * BigInt(10000 - slippage) / 10000n
if (minAmountOut <= 0n) throw new Error('Minimum output rounds to zero.')
const deadline = Number(block.timestamp) + 300
const traits = takerTraits(minAmountOut, BigInt(deadline))
const [balance, allowance] = await Promise.all([
  client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [taker], blockNumber: block.number }),
  client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [taker, d.router], blockNumber: block.number }),
])
if (balance < amountIn) throw new Error('Taker balance is insufficient.')
const data = encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [order, tokenIn, tokenOut, amountIn, traits] })
const approvalRequired = allowance < amountIn
if (!approvalRequired) await client.call({ account: taker, to: d.router, data, blockNumber: block.number })
const result = { chainId: sepolia.id, shipTransaction: tx.hash, strategyHash: values['strategy-hash'], maker: values.maker, taker,
  quoteBlock: String(block.number), amountIn: String(amountIn), quotedAmountOut: String(quoted[1]), minAmountOut: String(minAmountOut), deadline,
  approvalRequired, swapSimulation: approvalRequired ? 'awaiting-approval' : 'passed', signed: false, broadcast: false,
  approval: approvalRequired ? { from: taker, to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, amountIn] }), value: '0x0' } : null,
  transaction: { from: taker, to: d.router, data, value: '0x0' },
  contractFields: { order: { ...order, traits: String(order.traits) }, tokenIn, tokenOut, amount: String(amountIn), takerTraitsAndData: traits },
}
await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ ...result, transaction: '[unsigned calldata saved]', contractFields: '[saved]', approval: approvalRequired ? '[saved]' : null }))
