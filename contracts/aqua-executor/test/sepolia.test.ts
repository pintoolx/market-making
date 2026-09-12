import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, erc20Abi, parseEther, parseUnits, type PublicClient } from 'viem'
import { checkSepoliaAssets, DEMO_ACCOUNTS, fundingPlan, FUNDING_TARGET, SEPOLIA } from '../src/sepolia.ts'

const balances = () => ({
  maker: { address: DEMO_ACCOUNTS.maker, eth: parseEther('0.05'), weth: 0n, usdc: parseUnits('20', 6) },
  taker: { address: DEMO_ACCOUNTS.taker, eth: 0n, weth: 0n, usdc: 0n },
})
test('one faucet allocation funds both wallets, wrapping ETH instead of minting assets', () => {
  const plan = fundingPlan(balances())
  assert.deepEqual(plan.needs, [])
  assert.deepEqual(plan.steps.map(s => s.step), ['fund-taker-eth', 'wrap-weth', 'fund-taker-weth', 'fund-taker-usdc'])
  assert.equal(plan.steps[1]!.request.to, SEPOLIA.WETH)
  assert.equal(plan.steps[1]!.request.data, '0xd0e30db0')
  assert.equal(plan.steps[1]!.request.value, String(FUNDING_TARGET.makerWeth + FUNDING_TARGET.takerWeth))
  const transfer = decodeFunctionData({ abi: erc20Abi, data: plan.steps[3]!.request.data })
  assert.equal(transfer.functionName, 'transfer')
  assert.equal(transfer.args?.[0].toString().toLowerCase(), DEMO_ACCOUNTS.taker)
  assert.equal(transfer.args?.[1], parseUnits('5', 6))
})
test('funding preserves existing balances and exposes shortages before transactions', () => {
  const b = balances()
  b.maker.weth = FUNDING_TARGET.makerWeth
  b.taker = { ...b.taker, eth: FUNDING_TARGET.takerEth, weth: FUNDING_TARGET.takerWeth, usdc: FUNDING_TARGET.takerUsdc }
  assert.deepEqual(fundingPlan(b), { needs: [], steps: [] })
  b.maker.eth = 0n; b.maker.usdc = 0n
  assert.equal(fundingPlan(b).needs.length, 2)
  b.maker.weth = FUNDING_TARGET.makerWeth + FUNDING_TARGET.takerWeth
  b.taker.weth = 0n
  assert.ok(!fundingPlan(b).steps.some(s => s.step === 'wrap-weth'))
})
test('wrong chain, empty code and wrong decimals fail asset preflight', async () => {
  let chainId = 84532, code = '0x01', decimals = 18
  const pc = { getChainId: async () => chainId, getCode: async () => code,
    readContract: async ({ address, functionName }: { address: string; functionName: string }) =>
      functionName === 'symbol' ? address === SEPOLIA.WETH ? 'WETH' : 'USDC' : address === SEPOLIA.WETH ? decimals : 6,
  } as unknown as PublicClient
  await assert.rejects(checkSepoliaAssets(pc), /chainId/)
  chainId = SEPOLIA.chainId; code = '0x'
  await assert.rejects(checkSepoliaAssets(pc), /no deployed code/)
  code = '0x01'; decimals = 6
  await assert.rejects(checkSepoliaAssets(pc), /metadata/)
  decimals = 18
  await checkSepoliaAssets(pc)
})
