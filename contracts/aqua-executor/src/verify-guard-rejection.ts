import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { BaseError, decodeErrorResult, erc20Abi, type Abi } from 'viem'
import { fromEnv, loadDeployment, readJson, RECORDS_DIR } from './config.ts'
import { compileExecution } from './execution-compile.ts'
import { parseExecutionRequest } from './execution-request.ts'
import { buildTx, rawBalances, send, waitMined } from './executor.ts'
import { takerTraits } from './compile.ts'
import { recorder, runStamp } from './records.ts'

const { values } = parseArgs({ options: {
  network: { type: 'string', default: 'ethereum-sepolia' },
  request: { type: 'string' }, strategy: { type: 'string' },
  'mandate-api': { type: 'string' }, 'mandate-id': { type: 'string' }, 'provider-strategy-id': { type: 'string' },
} })

if (!values.request || !values.strategy) throw new Error('--request and --strategy are required')
const request = parseExecutionRequest(JSON.parse(readFileSync(values.request, 'utf8')))
const ship = parseExecutionRequest(JSON.parse(readFileSync(values.strategy, 'utf8')))
if (request.action !== 'swap' || ship.action !== 'ship') throw new Error('expected one swap request and one ship request')
const strategy = compileExecution(ship.strategy)
if (request.expectedStrategyHash !== strategy.strategyHash) throw new Error('swap and strategy hashes do not match')

const ctx = fromEnv(values.network), deployment = loadDeployment(ctx.chain.id)
const record = recorder({ dir: RECORDS_DIR, runId: `guard-rejection-${runStamp()}`, chainId: ctx.chain.id, explorer: ctx.explorer })
const tokenOut = strategy.tokens.find(token => token.toLowerCase() !== request.tokenIn.toLowerCase())
if (!tokenOut) throw new Error('swap input is not in the strategy pair')
const amountIn = BigInt(request.amountIn)
await send(ctx, ctx.taker, buildTx.approve(request.tokenIn, deployment.router, amountIn), 'taker-approve-for-guard-proof', record)
const rejectedRequest = buildTx.swap(deployment, strategy, request.tokenIn, tokenOut, amountIn, takerTraits(0n))

const guardAbi = (readJson('artifacts/AquaGuardV2.json') as { abi: Abi }).abi
let rejection = ''
try {
  await ctx.pc.call({ ...rejectedRequest, account: ctx.taker.account.address })
  throw new Error('inactive strategy unexpectedly passed simulation')
} catch (error) {
  if (!(error instanceof BaseError)) throw error
  const cause = error.walk(item => typeof (item as { data?: unknown }).data === 'string') as { data?: `0x${string}` } | null
  if (!cause?.data) throw new Error('Guard rejection had no decodable error')
  rejection = decodeErrorResult({ abi: guardAbi, data: cause.data }).errorName
  if (rejection !== 'StrategyNotActive') throw new Error(`expected StrategyNotActive, received ${rejection}`)
}

const snapshot = async () => ({
  aqua: await rawBalances(ctx, deployment, strategy),
  wallets: await Promise.all(strategy.tokens.flatMap(token => [ctx.maker, ctx.taker].map(wallet =>
    ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account.address] })))),
})
const before = await snapshot()
const receipt = await waitMined(ctx, await ctx.taker.sendTransaction({ ...rejectedRequest, gas: 500_000n }))
record.execution('swap-guard-rejected', receipt, strategy.strategyHash)
assert.equal(receipt.status, 'reverted')
assert.equal(receipt.logs.length, 0)
assert.deepEqual(await snapshot(), before)

const sync = [values['mandate-api'], values['mandate-id'], values['provider-strategy-id']]
if (sync.some(Boolean) && !sync.every(Boolean)) throw new Error('mandate sync requires all three mandate flags')
if (sync.every(Boolean)) {
  const response = await fetch(`${values['mandate-api']!.replace(/\/$/, '')}/v1/mandates/${encodeURIComponent(values['mandate-id']!)}/executions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      providerStrategyId: values['provider-strategy-id'], transactionHash: receipt.transactionHash, outcome: 'rejected',
    }),
  })
  if (!response.ok) throw new Error(`mandate service rejected Guard evidence (${response.status})`)
}
record.write({ kind: 'guard-rejection-check', expected_error: rejection, tx_hash: receipt.transactionHash, before })
console.log(JSON.stringify({ status: 'verified', error: rejection, transactionHash: receipt.transactionHash, records: record.file }))
