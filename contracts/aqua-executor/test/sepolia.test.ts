import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { decodeFunctionData, erc20Abi, parseEther, parseUnits, type PublicClient } from 'viem'
import { checkSepoliaAssets, DEMO_ACCOUNTS, fundingPlan, FUNDING_TARGET, guardIdentity, guardReleaseId, SEPOLIA, versionedGuardDeploymentFile } from '../src/sepolia.ts'

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

test('Guard deployment identity fails closed between simulation and production', () => {
  const { forwarder, workflowId, workflowOwner, simulation } = guardIdentity({})
  assert.equal(forwarder, SEPOLIA.simulationForwarder)
  assert.equal(workflowId, `0x${'0'.repeat(64)}`)
  assert.equal(workflowOwner, `0x${'0'.repeat(40)}`)
  assert.equal(simulation, true)
  assert.throws(() => guardIdentity({ production: true }), /forwarder/)
  assert.throws(() => guardIdentity({ forwarder: SEPOLIA.simulationForwarder, production: true }), /workflow-id/)
  assert.throws(() => guardIdentity({ workflowId: `0x${'1'.repeat(64)}` }), /simulation requires zero/)
  assert.deepEqual(guardIdentity({
    production: true,
    forwarder: '0x1111111111111111111111111111111111111111',
    workflowId: `0x${'2'.repeat(64)}`,
    workflowOwner: '0x3333333333333333333333333333333333333333',
  }), {
    simulation: false,
    forwarder: '0x1111111111111111111111111111111111111111',
    workflowId: `0x${'2'.repeat(64)}`,
    workflowOwner: '0x3333333333333333333333333333333333333333',
  })
})

test('current Guard release and versioned manifest names are deterministic', () => {
  const fake = { abi: [], bytecode: '0x1234' as const }
  assert.match(guardReleaseId(fake), /^guard-v2-[0-9a-f]{12}$/)
  assert.equal(guardReleaseId(fake), guardReleaseId(fake))
  assert.match(versionedGuardDeploymentFile('0x1111111111111111111111111111111111111111').pathname,
    /deployments\/11155111\.guard-0x1111111111111111111111111111111111111111\.json$/)
})

test('simulation-only setup commands cannot silently ignore production identity flags', () => {
  for (const action of ['deploy', 'upgrade-guard']) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/sepolia.ts', import.meta.url)), action, '--execute', '--production'], { encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /receiver identity options require deploy-guard/)
  }
})
