import { expect, test } from 'bun:test'
import { decodeAbiParameters, zeroAddress, zeroHash, type AbiParameter, type Hex } from 'viem'
import artifact from '../../../contracts/aqua-executor/artifacts/AquaGuard.json'
import deployment from '../../../contracts/aqua-executor/deployments/84532.json'
import fixture from '../../../docs/guard-report-v1/example.json'
import { SIMULATION_FORWARDER } from '../config'
import { simulationDeploymentPlan, smokeConfig } from './prepare'

test('unsigned creation binds a new Guard to the CLI forwarder, pinned router and simulation identity', () => {
  const plan = simulationDeploymentPlan()
  const constructor = artifact.abi.find(item => item.type === 'constructor')!
  expect(plan.chainId).toBe('84532')
  expect(plan.value).toBe('0')
  expect(plan.data.startsWith(artifact.bytecode)).toBe(true)
  const args = decodeAbiParameters(constructor.inputs as AbiParameter[], `0x${plan.data.slice(artifact.bytecode.length)}` as Hex)
  expect(args.map(v => typeof v === 'string' ? v.toLowerCase() : v)).toEqual([SIMULATION_FORWARDER, deployment.router, zeroHash, zeroAddress, true])
})

test('smoke reports cannot enable trades and do not invent a nonce', () => {
  const report = smokeConfig(fixture.report.guard, fixture.report.maker, '2', 1800000000).publicReport
  expect(report).toMatchObject({ nonce: '2', allowedDirections: '0', maxAmount0PerSwap: '0', maxAmount1PerSwap: '0',
    maxPostBalance0: '0', maxPostBalance1: '0', validAfter: '1800000000', validUntil: '1800000300' })
  expect(() => smokeConfig(fixture.report.guard, fixture.report.maker, '0', 1800000000)).toThrow('invalid public Guard report')
  expect(() => smokeConfig(zeroAddress, fixture.report.maker, '1', 1800000000)).toThrow('invalid public Guard report')
})
